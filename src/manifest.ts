import { privateKeyToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import type { IndexedSafe } from './scan.ts';

/**
 * The signed index manifest. Canonicalization matches @dsafe/protocol and
 * swarm-kit signed documents: the signature is over JSON.stringify of the
 * manifest with sig set to '' — EIP-191 personal_sign, verified with viem's
 * verifyMessage. So a swarm-kit / app verifier is wire-compatible.
 */
export interface SafeIndexEntry {
  address: string;
  owners: string[];
  threshold: number;
}

export interface SafeIndexManifest {
  schema: 'dsafe/safe-index/1';
  chainId: number;
  generatedAt: string;
  indexer: { signer: string };
  safeCount: number;
  safes: SafeIndexEntry[];
  sig: string;
}

export function buildManifest(chainId: number, safes: IndexedSafe[], generatedAt: string): Omit<SafeIndexManifest, 'sig'> {
  return {
    schema: 'dsafe/safe-index/1',
    chainId,
    generatedAt,
    indexer: { signer: '' }, // filled by sign()
    safeCount: safes.length,
    safes: safes.map(s => ({ address: s.address, owners: s.owners, threshold: s.threshold })),
  } as Omit<SafeIndexManifest, 'sig'>;
}

function signingBytes(manifest: Omit<SafeIndexManifest, 'sig'> & { sig?: string }): string {
  return JSON.stringify({ ...manifest, sig: '' });
}

export async function signManifest(
  manifest: Omit<SafeIndexManifest, 'sig' | 'indexer'> & { indexer: { signer: string } },
  signerKey: `0x${string}`,
): Promise<SafeIndexManifest> {
  const account = privateKeyToAccount(signerKey);
  const withSigner = { ...manifest, indexer: { signer: account.address } };
  const message = signingBytes(withSigner);
  const sig = await account.signMessage({ message });
  return { ...withSigner, sig } as SafeIndexManifest;
}

/** Client-side verification: recompute canonical bytes and check the signature. */
export async function verifyManifest(manifest: SafeIndexManifest): Promise<boolean> {
  const { sig, indexer } = manifest;
  if (!sig || !indexer?.signer) return false;
  return verifyMessage({
    address: indexer.signer as `0x${string}`,
    message: signingBytes(manifest),
    signature: sig as `0x${string}`,
  });
}
