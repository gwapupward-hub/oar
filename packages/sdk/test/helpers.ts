import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type EncodedAccount,
  type GetAccountInfoApi,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
} from '@solana/kit';
import { OAR_PROGRAM_ID } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const PROGRAM_SO = process.env.OAR_PROGRAM_BINARY ?? join(here, '../../../fixtures/reference/oar_registry.so');

export function createSvm(): LiteSVM {
  const svm = new LiteSVM();
  svm.addProgramFromFile(OAR_PROGRAM_ID, PROGRAM_SO);
  return svm;
}

export async function fundedSigner(svm: LiteSVM, sol = 10n): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  svm.airdrop(signer.address, lamports(sol * 1_000_000_000n));
  return signer;
}

export type SendResult = { ok: true; logs: string[] } | { ok: false; logs: string[]; error: string };

/** Build, sign and send one transaction; the fee payer must be one of the instruction signers or passed explicitly. */
export async function send(svm: LiteSVM, feePayer: KeyPairSigner, instructions: Instruction[]): Promise<SendResult> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0n }, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    return { ok: false, logs: res.meta().logs(), error: res.toString() };
  }
  return { ok: true, logs: res.logs() };
}

export function expectAnchorError(res: SendResult, code: number): void {
  if (res.ok) throw new Error(`expected error ${code}, transaction succeeded`);
  const joined = res.logs.join('\n');
  if (!joined.includes(`Error Number: ${code}.`)) {
    throw new Error(`expected Anchor error ${code}, got:\n${joined}\n${res.error}`);
  }
}

/** Minimal getAccountInfo RPC over LiteSVM so SDK fetch/resolve code runs unchanged. */
export function svmRpc(svm: LiteSVM): Rpc<GetAccountInfoApi> {
  return {
    getAccountInfo(address: Address) {
      return {
        send: async () => {
          const acct = svm.getAccount(address);
          if (!acct.exists) return { context: { slot: 0n }, value: null };
          return {
            context: { slot: 0n },
            value: {
              data: [Buffer.from(acct.data).toString('base64'), 'base64'],
              executable: acct.executable,
              lamports: acct.lamports,
              owner: acct.programAddress,
              rentEpoch: 0n,
              space: BigInt(acct.data.length),
            },
          };
        },
      };
    },
  } as unknown as Rpc<GetAccountInfoApi>;
}

export function setRawAccount(svm: LiteSVM, address: Address, owner: Address, data: Uint8Array): void {
  const account: EncodedAccount = {
    address,
    data,
    executable: false,
    lamports: lamports(10_000_000n),
    programAddress: owner,
    space: BigInt(data.length),
  };
  svm.setAccount(account);
}

/** fetch stub: map exact URLs to responses; anything else is a 404. */
export function stubFetch(routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
}
