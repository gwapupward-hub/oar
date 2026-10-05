import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getU32Encoder,
  getU64Encoder,
  type Address,
} from '@solana/kit';
import { PROGRAM_METADATA_PROGRAM_ID, findAppId, validateManifest } from '@open-app-registry/sdk';

const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], { encoding: 'utf8' });

/** A real ed25519 keypair file in the Solana CLI format, and its address. */
function keypairFile(dir: string, name: string): { path: string; address: Address } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify([...seed, ...pub]));
  return { path, address: getAddressDecoder().decode(pub) };
}

async function prepare(dir: string, creator: Address, extra: string[] = []) {
  const program = keypairFile(dir, 'program').address;
  const r = cli([
    'claim', 'prepare', '--creator', creator, '--name', 'Example App', '--domain', 'example.com', '--program', program,
    '--repo', 'https://github.com/example/app', '--category', 'defi', '--nonce', '0', '-d', join(dir, 'claim'), ...extra,
  ]);
  return { r, program };
}

test('claim prepare writes a valid manifest and both proof files for the derived App ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-claim-'));
  const creator = keypairFile(dir, 'creator').address;
  const { r, program } = await prepare(dir, creator);
  assert.equal(r.status, 0, r.stderr);
  const appId = await findAppId({ creator, nonce: 0 });
  assert.match(r.stdout, new RegExp(`App ID  ${appId}`));
  assert.match(r.stdout, /https:\/\/example\.com\/\.well-known\/oar-manifest\.json/);
  assert.match(r.stdout, /oar claim check --dir/);

  const read = (p: string) => JSON.parse(readFileSync(join(dir, 'claim', p), 'utf8'));
  const manifest = read('site/.well-known/oar-manifest.json');
  assert.equal(validateManifest(manifest).valid, true);
  assert.equal(manifest.app_id, appId);
  assert.deepEqual(manifest.programs, [{ address: program, cluster: 'solana:devnet' }]);
  assert.deepEqual(manifest.categories, ['defi']);
  const proof = { oar: '0.1', apps: [{ app_id: appId, cluster: 'solana:devnet' }] };
  assert.deepEqual(read('site/.well-known/oar.json'), proof);
  assert.deepEqual(read('repo/oar.json'), proof);
  assert.deepEqual(read('claim.json'), {
    cluster: 'solana:devnet', creator, nonce: '0', app_id: appId, authority: creator,
    manifest_uri: 'https://example.com/.well-known/oar-manifest.json',
  });

  // A second prepare does not silently replace the files a team may already have deployed.
  const again = await prepare(dir, creator);
  assert.equal(again.r.status, 1);
  assert.match(again.r.stderr, /exists \(use --force to overwrite\)/);
});

test('claim prepare needs somewhere to serve the manifest and refuses an invalid one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-claim-'));
  const creator = keypairFile(dir, 'creator').address;
  const noHost = cli(['claim', 'prepare', '--creator', creator, '--name', 'X', '--nonce', '0', '-d', join(dir, 'a')]);
  assert.equal(noHost.status, 1);
  assert.match(noHost.stderr, /Pass --domain, or --manifest-uri/);
  const badName = cli(['claim', 'prepare', '--creator', creator, '--name', 'x'.repeat(65), '--domain', 'example.com', '--nonce', '0', '-d', join(dir, 'b')]);
  assert.equal(badName.status, 1);
  assert.match(badName.stderr, /The manifest would be invalid/);
  assert.equal(existsSync(join(dir, 'b', 'claim.json')), false);
});

test('claim register refuses a keypair that is not the creator, and link-program a program the manifest does not list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-claim-'));
  const creator = keypairFile(dir, 'creator');
  const other = keypairFile(dir, 'other');
  assert.equal((await prepare(dir, creator.address)).r.status, 0);
  const claimDir = join(dir, 'claim');
  // Both refusals happen before any network call: the RPC URL points nowhere.
  const wrong = cli(['claim', 'register', '-d', claimDir, '-k', other.path, '-u', 'http://127.0.0.1:9']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, new RegExp(`derives from creator ${creator.address}; the keypair is ${other.address}`));
  const unlisted = cli(['claim', 'link-program', other.address, '-d', claimDir, '-k', creator.path, '-u', 'http://127.0.0.1:9']);
  assert.equal(unlisted.status, 1);
  assert.match(unlisted.stderr, /is not listed in the manifest/);
});

test('claim link-program --squads prints an unsigned transaction paid by the vault, and never sends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-claim-'));
  const creator = keypairFile(dir, 'creator');
  const vault = keypairFile(dir, 'vault').address;
  const { program } = await prepare(dir, creator.address);
  const loaderV3 = address('BPFLoaderUpgradeab1e11111111111111111111111');
  const [programData] = await getProgramDerivedAddress({ programAddress: loaderV3, seeds: [getAddressEncoder().encode(program)] });

  // Minimal devnet stand-in: the upgradeable program (vault is its upgrade authority), no backlink yet.
  const accounts: Record<string, { owner: Address; executable: boolean; data: Uint8Array }> = {
    [program]: { owner: loaderV3, executable: true, data: Uint8Array.from([...getU32Encoder().encode(2), ...getAddressEncoder().encode(programData)]) },
    [programData]: {
      owner: loaderV3, executable: false,
      data: Uint8Array.from([...getU32Encoder().encode(3), ...getU64Encoder().encode(1n), 1, ...getAddressEncoder().encode(vault)]),
    },
  };
  const methods: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      methods.push(method);
      let result: unknown = null;
      if (method === 'getAccountInfo') {
        const a = accounts[params[0]];
        result = { context: { slot: 1 }, value: a ? { data: [Buffer.from(a.data).toString('base64'), 'base64'], executable: a.executable, lamports: 1_000_000, owner: a.owner, rentEpoch: 0, space: a.data.length } : null };
      } else if (method === 'getMinimumBalanceForRentExemption') result = (128 + params[0]) * 6960;
      else if (method === 'getLatestBlockhash') result = { context: { slot: 1 }, value: { blockhash: vault, lastValidBlockHeight: 100 } };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const out = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', 'claim', 'link-program', program, '-d', join(dir, 'claim'), '--squads', vault, '-u', `http://127.0.0.1:${port}`]);
      let stdout = '', stderr = '';
      child.stdout.on('data', d => (stdout += d));
      child.stderr.on('data', d => (stderr += d));
      child.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /Creates the canonical "oar" Program Metadata account/);
    assert.match(out.stdout, new RegExp(`Signed by the upgrade authority ${vault}`));
    assert.match(out.stdout, /Import this base58 transaction into Squads/);
    assert.ok(!methods.includes('sendTransaction'), 'must not send');

    const encoded = out.stdout.trim().split('\n').at(-1)!;
    const tx = getTransactionDecoder().decode(getBase58Encoder().encode(encoded));
    assert.deepEqual(Object.keys(tx.signatures), [vault]);
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const programs = message.instructions.map(ix => message.staticAccounts[ix.programAddressIndex]);
    assert.deepEqual(programs, [address('11111111111111111111111111111111'), PROGRAM_METADATA_PROGRAM_ID]);
  } finally {
    server.close();
  }
});
