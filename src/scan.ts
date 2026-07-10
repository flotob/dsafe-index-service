import { createPublicClient, http, getAddress, parseAbiItem, type PublicClient } from 'viem';
import type { Config } from './config.ts';

/**
 * Discovers Safes from on-chain SafeSetup events and records their CURRENT
 * owner set (re-read via getOwners, so owner changes after setup are
 * reflected). Builds the owner→Safes index the frontend uses to answer "which
 * Safes do I own" without a centralized indexer.
 *
 * The trust model mirrors radicle-index-service: the index is discovery hints,
 * signed by a pinnable key. It can omit or lag, but a client verifies each
 * Safe's owners against the chain before trusting it — so a bad index can
 * withhold, never forge.
 */

export interface IndexedSafe {
  address: `0x${string}`;
  owners: `0x${string}`[];
  threshold: number;
  setupBlock: number;
}

// SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)
const SAFE_SETUP = parseAbiItem(
  'event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)',
);
const OWNERS_ABI = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export interface ScanResult {
  safes: IndexedSafe[];
  scannedToBlock: bigint;
}

export async function scanSafes(config: Config, fromBlock: bigint): Promise<ScanResult> {
  const client = createPublicClient({ transport: http(config.rpcUrl) }) as PublicClient;
  const latest = await client.getBlockNumber();
  const start = fromBlock > 0n ? fromBlock : maxBig(0n, latest - config.lookbackBlocks);

  // 1. Collect candidate Safe addresses + setup block from SafeSetup logs.
  const candidates = new Map<string, number>();
  for (let from = start; from <= latest; from += config.windowBlocks) {
    const to = minBig(from + config.windowBlocks - 1n, latest);
    const logs = await client.getLogs({ event: SAFE_SETUP, fromBlock: from, toBlock: to });
    for (const log of logs) {
      if (!log.address || log.blockNumber == null) continue;
      const addr = getAddress(log.address);
      if (!candidates.has(addr)) candidates.set(addr, Number(log.blockNumber));
    }
  }

  // 2. Read CURRENT owners/threshold for each candidate (reflects later owner
  // changes). Multicall keeps this to a couple of RPC calls even for many Safes.
  const addresses = [...candidates.keys()] as `0x${string}`[];
  const safes: IndexedSafe[] = [];
  const chunkSize = 200;
  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    const results = await client.multicall({
      allowFailure: true,
      multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11', // Multicall3, same on all chains
      contracts: chunk.flatMap(address => [
        { address, abi: OWNERS_ABI, functionName: 'getOwners' } as const,
        { address, abi: OWNERS_ABI, functionName: 'getThreshold' } as const,
      ]),
    });
    chunk.forEach((address, j) => {
      const ownersResult = results[j * 2];
      const thresholdResult = results[j * 2 + 1];
      if (ownersResult?.status !== 'success' || thresholdResult?.status !== 'success') return;
      const owners = (ownersResult.result as readonly string[]).map(o => getAddress(o));
      if (owners.length === 0) return;
      safes.push({
        address,
        owners,
        threshold: Number(thresholdResult.result as bigint),
        setupBlock: candidates.get(address) ?? 0,
      });
    });
  }

  safes.sort((a, b) => b.setupBlock - a.setupBlock);
  return { safes, scannedToBlock: latest };
}

function minBig(a: bigint, b: bigint): bigint { return a < b ? a : b; }
function maxBig(a: bigint, b: bigint): bigint { return a > b ? a : b; }
