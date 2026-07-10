import { Bee, PrivateKey, Topic } from '@ethersphere/bee-js';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SafeIndexManifest } from './manifest.ts';

// Feed topic clients pin alongside the signer address. Stable string → topic.
export const FEED_TOPIC = 'dsafe/safe-index/v1';

export interface Publisher {
  owner: string;
  feedManifest(): Promise<string>;
  publish(manifest: SafeIndexManifest, outDir: string): Promise<{ snapshotRef: string; feedManifest: string }>;
  batchTtlDays(): Promise<number>;
}

function toHex(value: { toString(): string }): string {
  const s = value.toString();
  return s.startsWith('0x') ? s : `0x${s}`;
}

// Batch ids arrive with or without a 0x prefix (env vs bee-js) — compare bare.
function bareId(value: { toString(): string }): string {
  return value.toString().toLowerCase().replace(/^0x/, '');
}

// Remaining batch lifetime in seconds. bee-js v9 exposes a `duration` Duration
// object ({seconds}); older versions used a numeric `batchTTL`. Handle both.
function batchSeconds(batch: any): number {
  const d = batch.duration;
  if (d && typeof d === 'object' && d.seconds != null) return Number(d.seconds);
  if (typeof d === 'number') return d;
  return Number(batch.batchTTL ?? 0);
}

async function selectBatch(bee: Bee): Promise<string | null> {
  const batches = await bee.getAllPostageBatch();
  let best: string | null = null;
  let bestTtl = -1;
  for (const batch of batches) {
    if (!batch.usable) continue;
    const amount = typeof batch.amount === 'string' ? BigInt(batch.amount) : BigInt(batch.amount ?? 0);
    if (amount <= 0n) continue; // zero-balance batches can't pay for pushsync
    const ttl = batchSeconds(batch);
    if (ttl > bestTtl) { best = toHex(batch.batchID); bestTtl = ttl; }
  }
  return best;
}

export async function createPublisher(
  beeUrl: string,
  signerKey: string,
  configuredBatch: string | null,
): Promise<Publisher> {
  const bee = new Bee(beeUrl);
  const signer = new PrivateKey(signerKey);
  const owner = signer.publicKey().address();
  const topic = Topic.fromString(FEED_TOPIC);
  const writer = bee.makeFeedWriter(topic, signer);

  const batchId = configuredBatch ?? (await selectBatch(bee));
  if (!batchId) throw new Error('No usable, funded postage batch on the bee node — buy one (mutable) first.');

  return {
    owner: owner.toString(),

    async feedManifest() {
      const ref = await bee.createFeedManifest(batchId, topic, owner);
      return toHex(ref);
    },

    async publish(manifest, outDir) {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      const names = await readdir(outDir);
      const files = await Promise.all(names.map(async name => {
        const data = await readFile(join(outDir, name));
        return new File([data], name, { type: 'application/json' });
      }));
      const upload = await bee.uploadFiles(batchId, files, { indexDocument: 'manifest.json', pin: true });
      const snapshotRef = toHex(upload.reference);
      await writer.uploadReference(batchId, upload.reference);
      const feedManifest = toHex(await bee.createFeedManifest(batchId, topic, owner));
      return { snapshotRef, feedManifest };
    },

    async batchTtlDays() {
      const batches = await bee.getAllPostageBatch();
      const batch = batches.find(b => bareId(b.batchID) === bareId(batchId));
      return batch ? Math.floor(batchSeconds(batch) / 86400) : 0;
    },
  };
}
