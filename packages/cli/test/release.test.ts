import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner } from '@solana/kit';
import { OAR_PROGRAM_ID } from '@open-app-registry/sdk';
import { sendAndConfirm } from '../src/tx.js';
test('exposed reference identity cannot be used for a live write or signing', async () => {
  const feePayer = await generateKeyPairSigner();
  const rpc = new Proxy({}, { get() { throw new Error('RPC must not be contacted'); } });
  await assert.rejects(sendAndConfirm(rpc as never, feePayer, [{ programAddress: OAR_PROGRAM_ID }]), /local-test-only/);
});
