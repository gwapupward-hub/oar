import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import type { Cluster } from '@open-app-registry/sdk';

export const DEFAULT_RPC: Record<Cluster, string> = {
  'solana:mainnet': 'https://api.mainnet-beta.solana.com',
  'solana:devnet': 'https://api.devnet.solana.com',
  'solana:testnet': 'https://api.testnet.solana.com',
};

export function parseCluster(value: string): Cluster {
  const v = value.replace(/^solana:/, '').replace(/-beta$/, '');
  if (v === 'mainnet' || v === 'devnet' || v === 'testnet') return `solana:${v}`;
  throw new Error(`Unknown cluster "${value}" (use mainnet, devnet or testnet)`);
}

export function rpcFor(cluster: Cluster, url?: string) {
  return createSolanaRpc(url ?? DEFAULT_RPC[cluster]);
}

export async function loadKeypair(path?: string): Promise<KeyPairSigner> {
  const file = path ?? join(homedir(), '.config', 'solana', 'id.json');
  const bytes = Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')) as number[]);
  return createKeyPairSignerFromBytes(bytes);
}

/** Sign, send and poll until confirmed (no websocket needed). */
export async function sendAndConfirm(
  rpc: ReturnType<typeof createSolanaRpc>,
  feePayer: KeyPairSigner,
  instructions: Instruction[],
  timeoutMs = 60_000,
): Promise<string> {
  if (instructions.some(ix => ix.programAddress === 'oarWKQoXgxp69Vupf883Pr1PvN35rAyZJeFu8q4pae5')) {
    throw new Error('The exposed reference program ID is local-test-only. Select and rebuild a fresh release identity before live writes.');
  }
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(tx);
  try {
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: 'confirmed' })
      .send();
  } catch (e) {
    // Surface the Anchor error line from preflight logs instead of a generic simulation failure.
    const logs = (e as { context?: { logs?: string[] } }).context?.logs ?? [];
    const anchor = logs.find(l => l.includes('Error Message:'));
    throw new Error(anchor ? anchor.replace(/^Program log: /, '') : (e as Error).message);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
    await new Promise(r => setTimeout(r, 1500));
  }
  // The transaction can still land after this; a blind retry could, for example, bump an app's revision twice.
  throw new Error(
    `Timed out waiting for ${signature} after ${timeoutMs / 1000}s. It may still land: check it (solana confirm ${signature}) before retrying.`,
  );
}
