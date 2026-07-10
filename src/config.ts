// All configuration is env-driven, with local-dev defaults. The one value with
// no default is FEED_SIGNER_KEY (publishing requires it; --dry-run doesn't).

export interface Config {
  chainId: number;
  rpcUrl: string;
  beeUrl: string;
  feedSignerKey: string | null;
  postageBatchId: string | null;
  /** First block to scan from (0 → derive from lookbackBlocks). */
  startBlock: bigint;
  lookbackBlocks: bigint;
  /** eth_getLogs window (public RPCs cap the range). */
  windowBlocks: bigint;
  intervalMinutes: number;
  outDir: string;
  stateFile: string;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback === undefined) throw new Error(`Missing env ${name}`);
    return fallback;
  }
  return value;
}

export function loadConfig(): Config {
  return {
    chainId: Number(env('CHAIN_ID', '100')),
    rpcUrl: env('GNOSIS_RPC', 'https://rpc.gnosischain.com'),
    beeUrl: env('BEE_URL', 'http://127.0.0.1:1633'),
    feedSignerKey: process.env.FEED_SIGNER_KEY || null,
    postageBatchId: process.env.POSTAGE_BATCH_ID || null,
    startBlock: BigInt(env('START_BLOCK', '0')),
    lookbackBlocks: BigInt(env('LOOKBACK_BLOCKS', '50000')),
    windowBlocks: BigInt(env('WINDOW_BLOCKS', '9000')),
    intervalMinutes: Number(env('INTERVAL_MINUTES', '10')),
    outDir: env('OUT_DIR', './out'),
    stateFile: env('STATE_FILE', './state.json'),
  };
}
