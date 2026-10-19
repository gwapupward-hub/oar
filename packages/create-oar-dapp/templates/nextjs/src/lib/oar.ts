// Server-only Solana Kit adapter for the existing OAR resolver.
// The SDK checks both the canonical Program Metadata backlink and the app manifest.
import 'server-only';
import { address, createSolanaRpc } from '@solana/kit';
import { resolveProgram } from '@open-app-registry/sdk';

export const OAR_CLUSTER = 'solana:devnet' as const;

/** Do not put API-key-bearing RPC URLs in NEXT_PUBLIC_ environment variables. */
function devnetRpcUrl(): string {
  const input = process.env.OAR_DEVNET_RPC_URL?.trim();
  if (!input && process.env.NODE_ENV === 'production') {
    throw new Error('Configure a dedicated OAR_DEVNET_RPC_URL on your server.');
  }
  const url = input ?? 'https://api.devnet.solana.com';
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid Devnet RPC URL.'); }
  if (parsed.protocol !== 'https:' ||
      parsed.username || parsed.password || parsed.hash) {
    throw new Error('RPC must be an HTTPS URL without embedded credentials or fragments.');
  }
  return url;
}

/**
 * A verifiable app identity for a specific deployed program.
 * Null means OAR could not establish a verified program link; it does not
 * mean the program is unsafe or inactive. No global trust badge is issued.
 */
export async function getVerifiedProgramIdentity(programId: string) {
  const rpc = createSolanaRpc(devnetRpcUrl());
  const result = await resolveProgram(rpc, address(programId), {
    cluster: OAR_CLUSTER,
    trustedIssuers: [],
  });
  if (result && 'status' in result && result.status === 'unavailable') {
    // Let callers show a retry state rather than a false "not verified" result.
    throw new Error('OAR verification temporarily unavailable; retry the RPC request.');
  }
  if (!result || result.link?.state !== 'verified' || !result.app.manifest.ok) return null;
  return {
    appId: result.app.appId,
    name: result.app.manifest.manifest.name,
    program: result.program,
    programLink: 'verified' as const,
    cluster: OAR_CLUSTER,
  };
}
