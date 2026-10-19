import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

test('an unreachable RPC is reported as retryable (exit 2), never as an absent record or backlink', async () => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end(); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  try {
    const id = '11111111111111111111111111111111';
    const inspect = await run(['inspect', id, '--rpc', rpc, '--no-live']);
    assert.equal(inspect.code, 2, inspect.stderr);
    assert.match(inspect.stderr, /unavailable; retry/);
    assert.doesNotMatch(inspect.stderr, /No AppRecord/);

    const json = await run(['inspect', id, '--rpc', rpc, '--no-live', '--json']);
    assert.equal(json.code, 2, json.stderr);
    assert.equal(JSON.parse(json.stdout).status, 'unavailable');

    const prog = await run(['resolve-program', id, '--rpc', rpc, '--no-live', '--json']);
    assert.equal(prog.code, 2, prog.stderr);
    assert.equal(JSON.parse(prog.stdout).status, 'unavailable');
  } finally {
    server.close();
  }
});
