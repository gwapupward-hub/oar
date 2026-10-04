import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address, generateKeyPairSigner } from '@solana/kit';
import { sendAndConfirm } from '../src/tx.js';
test('exposed reference identity cannot be used for a live write or signing', async () => {
  const feePayer = await generateKeyPairSigner();
  const rpc = new Proxy({}, { get() { throw new Error('RPC must not be contacted'); } });
  await assert.rejects(sendAndConfirm(rpc as never, feePayer, [{ programAddress: address('oarWKQoXgxp69Vupf883Pr1PvN35rAyZJeFu8q4pae5') }]), /local-test-only/);
});
