import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiteSVM } from 'litesvm';
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getTransactionDecoder,
  getU32Encoder,
  getU64Encoder,
  getUtf8Decoder,
  getUtf8Encoder,
  lamports,
  type Address,
  type GetAccountInfoApi,
  type GetMinimumBalanceForRentExemptionApi,
  type Instruction,
  type Rpc,
} from '@solana/kit';
import {
  Compression,
  DataSource,
  Encoding,
  Format,
  findCanonicalPda,
  getMetadataEncoder,
  packDirectData,
  parseInitializeInstruction,
  parseSetDataInstruction,
} from '@solana-program/program-metadata';
import {
  PROGRAM_METADATA_PROGRAM_ID,
  assertRegistrationInstructions,
  buildClaimFiles,
  buildProgramLink,
  checkManifestHosting,
  describeProgramLink,
  describeRegistration,
  exportUnsignedTransaction,
  findAppId,
  getProgramLinkInstructions,
  getRegisterInstructionAsync,
  hashManifest,
  hashManifestHex,
  nextAppNonce,
  validateManifest,
  type Cluster,
} from '../src/index.js';
import { createSvm, fundedSigner, send, setRawAccount, stubFetch, svmRpc } from './helpers.js';

const LOADER_V3 = address('BPFLoaderUpgradeab1e11111111111111111111111');
const LOADER_V2 = address('BPFLoader2111111111111111111111111111111111');
const SYSTEM = address('11111111111111111111111111111111');
const CLUSTER: Cluster = 'solana:devnet';

function rpcFor(svm: LiteSVM): Rpc<GetAccountInfoApi & GetMinimumBalanceForRentExemptionApi> {
  const base = svmRpc(svm) as unknown as Record<string, unknown>;
  return {
    ...base,
    getMinimumBalanceForRentExemption: (space: bigint) => ({ send: async () => lamports(svm.minimumBalanceForRentExemption(space)) }),
  } as unknown as Rpc<GetAccountInfoApi & GetMinimumBalanceForRentExemptionApi>;
}

function setExecutable(svm: LiteSVM, addr: Address, owner: Address, data: Uint8Array): void {
  svm.setAccount({ address: addr, data, executable: true, lamports: lamports(10_000_000n), programAddress: owner, space: BigInt(data.length) });
}

/** An upgradeable (loader v3) program whose ProgramData names `authority`, or no authority when frozen. */
async function deployUpgradeable(svm: LiteSVM, authority: Address | null): Promise<Address> {
  const program = (await generateKeyPairSigner()).address;
  const [programData] = await import('@solana/kit').then(k =>
    k.getProgramDerivedAddress({ programAddress: LOADER_V3, seeds: [getAddressEncoder().encode(program)] }),
  );
  setExecutable(svm, program, LOADER_V3, Uint8Array.from([...getU32Encoder().encode(2), ...getAddressEncoder().encode(programData)]));
  const header = [...getU32Encoder().encode(3), ...getU64Encoder().encode(1n)];
  const auth = authority ? [1, ...getAddressEncoder().encode(authority)] : [0];
  setRawAccount(svm, programData, LOADER_V3, Uint8Array.from([...header, ...auth, 0x7f, 0x45, 0x4c, 0x46]));
  return program;
}

/** A canonical "oar" metadata account with the given content, as the Program Metadata CLI would write it. */
async function setBacklink(svm: LiteSVM, program: Address, content: string, opts: { mutable?: boolean; compression?: Compression } = {}) {
  const [metadata] = await findCanonicalPda({ program, seed: 'oar' });
  const packed = packDirectData({ content, compression: opts.compression ?? Compression.Zlib, encoding: Encoding.Utf8 });
  const bytes = getMetadataEncoder().encode({
    program, authority: null, mutable: opts.mutable ?? true, canonical: true, seed: 'oar', encoding: packed.encoding,
    compression: packed.compression, format: Format.Json, dataSource: DataSource.Direct, dataLength: packed.data.length, data: packed.data,
  });
  setRawAccount(svm, metadata, PROGRAM_METADATA_PROGRAM_ID, Uint8Array.from(bytes));
  return metadata;
}

const ixData = (ix: Instruction) => ix as Instruction & { data: Uint8Array; accounts: { address: Address }[] };

test('linking a fresh program creates the canonical account with readable, uncompressed content', async () => {
  const svm = new LiteSVM();
  const authority = await generateKeyPairSigner();
  const program = await deployUpgradeable(svm, authority.address);
  const appId = await findAppId({ creator: authority.address, nonce: 0 });

  const plan = await getProgramLinkInstructions(rpcFor(svm), { program, appId, cluster: CLUSTER, authority, payer: authority });
  const [metadata] = await findCanonicalPda({ program, seed: 'oar' });
  assert.equal(plan.action, 'create');
  assert.equal(plan.metadata, metadata);
  assert.equal(plan.upgradeAuthority, authority.address);
  assert.equal(plan.content, JSON.stringify(buildProgramLink(appId, CLUSTER)));
  assert.ok(plan.rentLamports > 0n);
  assert.deepEqual(plan.instructions.map(i => i.programAddress), [SYSTEM, PROGRAM_METADATA_PROGRAM_ID]);
  assertRegistrationInstructions(plan.instructions);

  const init = parseInitializeInstruction(ixData(plan.instructions[1]));
  assert.equal(init.accounts.metadata.address, metadata);
  assert.equal(init.accounts.authority.address, authority.address);
  assert.equal(init.accounts.program.address, program);
  assert.equal(init.data.seed, 'oar');
  assert.equal(init.data.compression, Compression.None);
  assert.equal(init.data.encoding, Encoding.Utf8);
  assert.equal(init.data.format, Format.Json);
  assert.equal(init.data.dataSource, DataSource.Direct);
  const written = init.data.data;
  assert.ok(written && written.__option === 'Some');
  assert.equal(getUtf8Decoder().decode(written.value), plan.content);

  const lines = describeProgramLink(plan, authority.address);
  assert.match(lines[0], /^Creates the canonical "oar" Program Metadata account/);
  assert.ok(lines.some(l => l.includes(plan.content)));
  assert.ok(lines.some(l => l.includes('changes no program code and no authority')));
});

test('only the upgrade authority can link, and frozen or non-upgradeable programs are refused', async () => {
  const svm = new LiteSVM();
  const authority = await generateKeyPairSigner();
  const stranger = await generateKeyPairSigner();
  const appId = await findAppId({ creator: authority.address, nonce: 0 });
  const rpc = rpcFor(svm);

  const program = await deployUpgradeable(svm, authority.address);
  await assert.rejects(
    getProgramLinkInstructions(rpc, { program, appId, cluster: CLUSTER, authority: stranger, payer: stranger }),
    /Only the upgrade authority .* can link/,
  );
  const frozen = await deployUpgradeable(svm, null);
  await assert.rejects(getProgramLinkInstructions(rpc, { program: frozen, appId, cluster: CLUSTER, authority, payer: authority }), /is immutable/);
  // LiteSVM will not hold a fake loader-v2 program, so serve that one account directly.
  const legacy = (await generateKeyPairSigner()).address;
  const legacyRpc = {
    ...(rpc as unknown as Record<string, unknown>),
    getAccountInfo: (a: Address, c?: unknown) =>
      a === legacy
        ? { send: async () => ({ context: { slot: 0n }, value: { data: ['f0VMRg==', 'base64'], executable: true, lamports: 1n, owner: LOADER_V2, rentEpoch: 0n, space: 4n } }) }
        : (rpc as unknown as { getAccountInfo: (a: Address, c?: unknown) => unknown }).getAccountInfo(a, c),
  } as unknown as typeof rpc;
  await assert.rejects(getProgramLinkInstructions(legacyRpc, { program: legacy, appId, cluster: CLUSTER, authority, payer: authority }), /not an upgradeable program/);
  const missing = (await generateKeyPairSigner()).address;
  await assert.rejects(getProgramLinkInstructions(rpc, { program: missing, appId, cluster: CLUSTER, authority, payer: authority }), /not a deployed program/);
});

test('an existing backlink is left alone when it already names the app, rewritten otherwise, and never when frozen', async () => {
  const svm = new LiteSVM();
  const authority = await generateKeyPairSigner();
  const program = await deployUpgradeable(svm, authority.address);
  const appId = await findAppId({ creator: authority.address, nonce: 0 });
  const other = await findAppId({ creator: authority.address, nonce: 7 });
  const rpc = rpcFor(svm);
  const input = { program, appId, cluster: CLUSTER, authority, payer: authority };

  // Same link written by the Program Metadata CLI (zlib, different key order): nothing to sign.
  await setBacklink(svm, program, JSON.stringify({ cluster: CLUSTER, app: appId, oar: '0.1' }));
  const same = await getProgramLinkInstructions(rpc, input);
  assert.equal(same.action, 'unchanged');
  assert.deepEqual(same.instructions, []);
  assert.match(describeProgramLink(same, authority.address)[0], /already points to this App ID/);

  const previous = JSON.stringify(buildProgramLink(other, CLUSTER));
  const metadata = await setBacklink(svm, program, previous, { compression: Compression.None });
  const update = await getProgramLinkInstructions(rpc, input);
  assert.equal(update.action, 'update');
  assert.equal(update.previous, previous);
  const setData = update.instructions.find(i => i.programAddress === PROGRAM_METADATA_PROGRAM_ID)!;
  const parsed = parseSetDataInstruction(ixData(setData));
  assert.equal(parsed.accounts.metadata.address, metadata);
  assert.equal(parsed.data.compression, Compression.None);
  assert.ok(describeProgramLink(update, authority.address).some(l => l === `It replaces: ${previous}`));

  // A repeated key is invalid to the verifier, so it is rewritten rather than reported as already linked.
  await setBacklink(svm, program, `{"oar":"0.1","app":"${other}","app":"${appId}","cluster":"${CLUSTER}"}`, { compression: Compression.None });
  assert.equal((await getProgramLinkInstructions(rpc, input)).action, 'update');

  await setBacklink(svm, program, previous, { mutable: false });
  await assert.rejects(getProgramLinkInstructions(rpc, input), /is frozen at .* cannot be changed/);
});

test('nextAppNonce skips nonces that already hold a record', async () => {
  const svm = new LiteSVM();
  const creator = (await generateKeyPairSigner()).address;
  const rpc = svmRpc(svm);
  assert.deepEqual(await nextAppNonce(rpc, creator), { nonce: 0n, appId: await findAppId({ creator, nonce: 0 }) });
  for (const n of [0, 1]) setRawAccount(svm, await findAppId({ creator, nonce: n }), SYSTEM, new Uint8Array(8));
  assert.deepEqual(await nextAppNonce(rpc, creator), { nonce: 2n, appId: await findAppId({ creator, nonce: 2 }) });
  await assert.rejects(nextAppNonce(rpc, creator, { limit: 2n }), /No free nonce between 0 and 1/);
});

test('after a real register, nextAppNonce moves to the next App ID', async () => {
  const svm = createSvm();
  const creator = await fundedSigner(svm);
  const rpc = svmRpc(svm);
  const first = await nextAppNonce(rpc, creator.address);
  const manifest = { oar: '0.1', app_id: first.appId, cluster: CLUSTER, name: 'Example', categories: ['other'] };
  const ix = await getRegisterInstructionAsync({
    creator, nonce: first.nonce, authority: creator.address, manifestUri: 'https://example.com/.well-known/oar-manifest.json', manifestHash: hashManifest(manifest),
  });
  assertRegistrationInstructions([ix]);
  const res = await send(svm, creator, [ix]);
  assert.ok(res.ok, res.ok ? '' : res.error);
  assert.deepEqual(await nextAppNonce(rpc, creator.address), { nonce: 1n, appId: await findAppId({ creator: creator.address, nonce: 1 }) });
});

test('registration summary names the authority and says when it has not signed', async () => {
  const creator = (await generateKeyPairSigner()).address;
  const vault = (await generateKeyPairSigner()).address;
  const appId = await findAppId({ creator, nonce: 0 });
  const base = { appId, cluster: CLUSTER, creator, nonce: 0n, manifestUri: 'https://example.com/.well-known/oar-manifest.json', manifestSha256: 'ab'.repeat(32) };
  const self = describeRegistration({ ...base, authority: creator });
  assert.ok(self[0].includes(appId) && self.every(l => !l.includes('does not sign now')));
  const multisig = describeRegistration({ ...base, authority: vault });
  assert.ok(multisig.some(l => l.includes(vault)) && multisig.some(l => l.includes('does not sign now')));
});

test('multisig export is an unsigned transaction paid by the vault, and refuses foreign instructions', async () => {
  const svm = new LiteSVM();
  const vault = await generateKeyPairSigner();
  const program = await deployUpgradeable(svm, vault.address);
  const appId = await findAppId({ creator: vault.address, nonce: 0 });
  const { createNoopSigner } = await import('@solana/kit');
  const signer = createNoopSigner(vault.address);
  const plan = await getProgramLinkInstructions(rpcFor(svm), { program, appId, cluster: CLUSTER, authority: signer, payer: signer });
  const blockhash = { blockhash: svm.latestBlockhash() as never, lastValidBlockHeight: 0n };

  const exported = exportUnsignedTransaction(plan.instructions, vault.address, blockhash);
  const tx = getTransactionDecoder().decode(Buffer.from(exported.base64, 'base64'));
  assert.deepEqual(Object.keys(tx.signatures), [vault.address]);
  assert.equal(tx.signatures[vault.address], null);
  assert.equal(Buffer.from(exported.base64, 'base64').length, (await import('@solana/kit')).getBase58Encoder().encode(exported.base58).length);

  const legacy = exportUnsignedTransaction(plan.instructions, vault.address, blockhash, { version: 'legacy' });
  const legacyBytes = getTransactionDecoder().decode(Buffer.from(legacy.base64, 'base64')).messageBytes;
  assert.equal(legacyBytes[0] & 0x80, 0, 'legacy messages carry no version prefix');
  assert.equal(getTransactionDecoder().decode(Buffer.from(exported.base64, 'base64')).messageBytes[0], 0x80, 'v0 prefix');

  const memo: Instruction = { programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: getUtf8Encoder().encode('x') };
  assert.throws(() => exportUnsignedTransaction([...plan.instructions, memo], vault.address, blockhash), /Refusing to sign: an instruction calls MemoSq4/);
});

test('hosting check confirms the served manifest is the one being committed', async () => {
  const manifest = { oar: '0.1', app_id: 'x', cluster: CLUSTER, name: 'Example', categories: ['other'] };
  const uri = 'https://example.com/.well-known/oar-manifest.json';
  const served = (body: string) => ({ fetch: stubFetch({ [uri]: { body } }) });

  // Key order and whitespace do not matter: the hash is over the canonical form.
  const ok = await checkManifestHosting(uri, manifest, served(JSON.stringify({ ...manifest, name: 'Example' }, Object.keys(manifest).reverse(), 4)));
  assert.deepEqual(ok, { ok: true, sha256: hashManifestHex(manifest) });
  const stale = await checkManifestHosting(uri, manifest, served(JSON.stringify({ ...manifest, name: 'Old name' })));
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok && stale.reason === 'different' && stale.detail.includes(hashManifestHex(manifest)));
  const missing = await checkManifestHosting(uri, manifest, { fetch: stubFetch({}) });
  assert.ok(!missing.ok && missing.reason === 'unreachable');
  const duplicate = await checkManifestHosting(uri, manifest, served('{"oar":"0.1","oar":"0.1"}'));
  assert.ok(!duplicate.ok && duplicate.reason === 'unreachable' && /Duplicate JSON key/.test(duplicate.detail));
});

test('claim files: a valid manifest, one proof for every domain and repository, and the default manifest location', async () => {
  const creator = (await generateKeyPairSigner()).address;
  const program = (await generateKeyPairSigner()).address;
  const appId = await findAppId({ creator, nonce: 0 });
  const files = buildClaimFiles({
    appId, cluster: CLUSTER, name: 'Example', categories: ['defi'], domains: [' MyApp.xyz '], programs: [program],
    repositories: ['https://github.com/example/app'],
  });
  assert.equal(validateManifest(files.manifest).valid, true);
  assert.equal(files.manifestUri, 'https://myapp.xyz/.well-known/oar-manifest.json');
  assert.deepEqual(files.manifest.domains, ['myapp.xyz']);
  assert.deepEqual(files.manifest.links, { website: 'https://myapp.xyz' });
  assert.deepEqual(files.manifest.programs, [{ address: program, cluster: CLUSTER }]);
  assert.deepEqual(files.manifest.repositories, [{ url: 'https://github.com/example/app', role: 'app' }]);
  assert.deepEqual(files.wellKnown, { oar: '0.1', apps: [{ app_id: appId, cluster: CLUSTER }] });
  assert.deepEqual(files.repoProof, files.wellKnown);

  const minimal = buildClaimFiles({ appId, cluster: CLUSTER, name: 'Example', manifestUri: 'ar://abc' });
  assert.deepEqual(minimal.manifest.categories, ['other']);
  assert.equal(minimal.repoProof, undefined);
  assert.equal('domains' in minimal.manifest, false);
  assert.throws(() => buildClaimFiles({ appId, cluster: CLUSTER, name: 'Example' }), /Give a domain, or a URI/);
});
