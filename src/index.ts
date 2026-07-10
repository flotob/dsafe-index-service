import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { scanSafes } from './scan.ts';
import { buildManifest, signManifest, verifyManifest } from './manifest.ts';
import { createPublisher } from './publish.ts';

// dSAFE Safe-index service: watch Safe deployments on Gnosis, publish a signed
// owner→Safes index to Swarm. Mirrors the radicle-index-service pattern —
// signed, versioned, feed-backed; clients pin the signer and verify.
//
//   --once      one cycle then exit
//   --dry-run   scan + build + sign, skip Swarm publish (prints the manifest)

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const DRY_RUN = args.has('--dry-run');

const log = (...a: unknown[]) => console.log('[safe-index]', ...a);

interface State { lastPublishedHash?: string }

async function loadState(file: string): Promise<State> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}
async function saveState(file: string, state: State): Promise<void> {
  await writeFile(file, JSON.stringify(state, null, 2));
}

async function cycle(nowIso: string): Promise<void> {
  const config = loadConfig();

  log(`scanning chain ${config.chainId} from ${config.rpcUrl}`);
  const { safes, scannedToBlock } = await scanSafes(config, config.startBlock);
  log(`found ${safes.length} Safes up to block ${scannedToBlock}`);

  const unsigned = buildManifest(config.chainId, safes, nowIso);

  if (DRY_RUN || !config.feedSignerKey) {
    if (!config.feedSignerKey) log('no FEED_SIGNER_KEY — dry run only');
    const preview = { ...unsigned, indexer: { signer: '<unsigned>' }, sig: '' };
    log('manifest preview:', JSON.stringify({ ...preview, safes: preview.safes.slice(0, 3) }, null, 2));
    log(`(${safes.length} Safes total; publish skipped)`);
    return;
  }

  const manifest = await signManifest(unsigned, config.feedSignerKey as `0x${string}`);
  if (!(await verifyManifest(manifest))) throw new Error('self-verification failed after signing');
  log(`signed by ${manifest.indexer.signer}`);

  // Publish-on-change: hash the signed content excluding generatedAt so an
  // unchanged index doesn't churn the feed.
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ ...manifest, generatedAt: '', sig: '' }))
    .digest('hex');
  const state = await loadState(config.stateFile);
  if (state.lastPublishedHash === contentHash) {
    log('index unchanged since last publish — skipping');
    return;
  }

  const publisher = await createPublisher(config.beeUrl, config.feedSignerKey, config.postageBatchId);
  const { snapshotRef, feedManifest } = await publisher.publish(manifest, config.outDir);
  await saveState(config.stateFile, { lastPublishedHash: contentHash });

  const ttl = await publisher.batchTtlDays();
  log(`published snapshot ${snapshotRef}`);
  log(`feed manifest (pin this): ${feedManifest}`);
  log(`signer (pin this): ${manifest.indexer.signer}`);
  log(`read at: ${config.beeUrl}/bzz/${feedManifest.replace(/^0x/, '')}/manifest.json`);
  if (ttl < 30) log(`WARNING: postage batch TTL is ${ttl} days`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  // generatedAt is passed in (Date.now unavailable in some sandboxes is fine
  // here — this is a normal Node process).
  if (ONCE || DRY_RUN) {
    await cycle(new Date().toISOString());
    return;
  }
  log(`daemon: every ${config.intervalMinutes} min`);
  for (;;) {
    try { await cycle(new Date().toISOString()); }
    catch (error) { console.error('[safe-index] cycle failed:', error instanceof Error ? error.message : error); }
    await new Promise(r => setTimeout(r, config.intervalMinutes * 60_000));
  }
}

main().catch(error => { console.error('[safe-index] fatal:', error); process.exit(1); });
