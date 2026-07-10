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

async function selectBatch(bee: Bee): Promise<string | null> {
  const batches = await bee.getAllPostageBatch();
  let best: string | null = null;
  let bestTtl = -1;
  for (const batch of batches) {
    if (!batch.usable) continue;
    const amount = typeof batch.amount === 'string' ? BigInt(batch.amount) : BigInt(batch.amount ?? 0);
    if (amount <= 0n) continue; // zero-balance batches can't pay for pushsync
    const ttl = batch.batchTTL ?? 0;
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
      const batch = batches.find(b => toHex(b.batchID).toLowerCase() === batchId.toLowerCase());
      return batch ? Math.floor((batch.batchTTL ?? 0) / 86400) : 0;
    },
  };
}
