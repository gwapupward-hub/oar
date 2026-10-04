// Generated program client (instructions, AppRecord codec, errors, events).
export * from './generated/index.js';

export * from './constants.js';
export * from './json.js';
export * from './manifest.js';
export * from './links.js';
export * from './attestations.js';
export * from './resolve.js';
export { HttpCheckError } from './http.js';

import type { Address } from '@solana/kit';
import { findAppRecordPda } from './generated/index.js';

/** App ID = PDA of ["app", creator, nonce_le_u64] under the OAR program. */
export async function findAppId(args: { creator: Address; nonce: number | bigint }): Promise<Address> {
  const [pda] = await findAppRecordPda(args);
  return pda;
}
