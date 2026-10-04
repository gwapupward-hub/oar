import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address, generateKeyPairSigner } from '@solana/kit';
import { sendAndConfirm } from '../src/tx.js';
test('exposed reference identity cannot be used for a live write or signing', async () => {
  const feePayer = await generateKeyPairSigner();
  const rpc = new Proxy({}, { get() { throw new Error('RPC must not be contacted'); } });
  await assert.rejects(sendAndConfirm(rpc as never, feePayer, [{ programAddress: address('oarWKQoXgxp69Vupf883Pr1PvN35rAyZJeFu8q4pae5') }]), /local-test-only/);
});

test('a confirmation timeout names the signature and warns against a blind retry', async () => {
  const feePayer = await generateKeyPairSigner();
  const blockhash = (await generateKeyPairSigner()).address;
  const call = (value: unknown) => () => ({ send: async () => value });
  const rpc = {
    getLatestBlockhash: call({ value: { blockhash, lastValidBlockHeight: 1n } }),
    sendTransaction: call('sent'),
    getSignatureStatuses: call({ value: [null] }),
  };
  const program = (await generateKeyPairSigner()).address;
  await assert.rejects(sendAndConfirm(rpc as never, feePayer, [{ programAddress: program }], 10), (e: Error) =>
    /^Timed out waiting for \w+ after 0\.01s\. It may still land: check it \(solana confirm \w+\) before retrying\.$/.test(e.message));
});

test('manifest files with a repeated key are refused by validate and hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-cli-'));
  const file = join(dir, 'oar.manifest.json');
  writeFileSync(file, '{"oar":"0.1","name":"Trusted Wallet","name":"Other"}');
  for (const cmd of ['validate', 'hash']) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', cmd, file], { encoding: 'utf8' });
    assert.equal(r.status, 1, cmd);
    assert.match(r.stderr, /Error: Duplicate JSON key "name"/, cmd);
    assert.equal(r.stdout, '', cmd);
  }
});
