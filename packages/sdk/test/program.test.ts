import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddressEncoder, generateKeyPairSigner, type Address } from '@solana/kit';
import {
  APP_RECORD_OFFSETS,
  APP_RECORD_SIZE,
  AppStatus,
  OAR_PROGRAM_ID,
  decodeAppRecord,
  fetchMaybeAppRecord,
  findAppId,
  getAcceptAuthorityInstruction,
  getProposeAuthorityInstruction,
  getRegisterInstructionAsync,
  getSetStatusInstruction,
  getUpdateManifestInstruction,
} from '../src/index.js';
import { createSvm, expectAnchorError, fundedSigner, send, svmRpc } from './helpers.js';

const HASH_A = new Uint8Array(32).fill(7);
const HASH_B = new Uint8Array(32).fill(9);
const URI_A = 'ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U';
const URI_B = 'https://gwapspot.fun/oar-manifest.json';
const ZERO = '11111111111111111111111111111111' as Address;

async function setup(nonce = 0n) {
  const svm = createSvm();
  const creator = await fundedSigner(svm);
  const appId = await findAppId({ creator: creator.address, nonce });
  return { svm, creator, appId, rpc: svmRpc(svm) };
}

async function register(ctx: Awaited<ReturnType<typeof setup>>, over: Partial<{ nonce: bigint; authority: Address; uri: string; hash: Uint8Array }> = {}) {
  const ix = await getRegisterInstructionAsync({
    creator: ctx.creator,
    nonce: over.nonce ?? 0n,
    authority: over.authority ?? ctx.creator.address,
    manifestUri: over.uri ?? URI_A,
    manifestHash: over.hash ?? HASH_A,
  });
  return send(ctx.svm, ctx.creator, [ix]);
}

test('register creates the record at the derived App ID with the spec layout', async () => {
  const ctx = await setup();
  const res = await register(ctx);
  assert.ok(res.ok, res.ok ? '' : res.logs.join('\n'));

  const raw = ctx.svm.getAccount(ctx.appId);
  assert.ok(raw.exists);
  assert.equal(raw.programAddress, OAR_PROGRAM_ID);
  assert.equal(raw.data.length, APP_RECORD_SIZE);
  const enc = getAddressEncoder();
  assert.deepEqual(raw.data.slice(APP_RECORD_OFFSETS.creator, APP_RECORD_OFFSETS.creator + 32), Uint8Array.from(enc.encode(ctx.creator.address)));
  assert.deepEqual(raw.data.slice(APP_RECORD_OFFSETS.authority, APP_RECORD_OFFSETS.authority + 32), Uint8Array.from(enc.encode(ctx.creator.address)));
  assert.equal(raw.data[8], 1, 'layout_version');
  assert.equal(raw.data[10], AppStatus.Active, 'status');

  const rec = await fetchMaybeAppRecord(ctx.rpc, ctx.appId);
  assert.ok(rec.exists);
  assert.equal(rec.data.creator, ctx.creator.address);
  assert.equal(rec.data.authority, ctx.creator.address);
  assert.equal(rec.data.pendingAuthority, ZERO);
  assert.equal(rec.data.nonce, 0n);
  assert.equal(rec.data.revision, 0);
  assert.equal(rec.data.manifestUri, URI_A);
  assert.deepEqual(Uint8Array.from(rec.data.manifestHash), HASH_A);
  assert.ok(res.logs.some(l => l.startsWith('Program data: ')), 'AppRegistered event emitted');
});

test('register can set a different authority (e.g. a multisig vault)', async () => {
  const ctx = await setup();
  const vault = await generateKeyPairSigner();
  assert.ok((await register(ctx, { authority: vault.address })).ok);
  const rec = decodeAppRecord(ctx.svm.getAccount(ctx.appId) as never);
  assert.equal(rec.data.authority, vault.address);
  assert.equal(rec.data.creator, ctx.creator.address);
});

test('register rejects bad input and duplicates', async () => {
  const ctx = await setup();
  expectAnchorError(await register(ctx, { uri: '' }), 6000);
  expectAnchorError(await register(ctx, { uri: 'h'.repeat(257) }), 6001);
  expectAnchorError(await register(ctx, { uri: 'https://x.y/a b' }), 6002);
  expectAnchorError(await register(ctx, { hash: new Uint8Array(32) }), 6003);
  expectAnchorError(await register(ctx, { authority: ZERO }), 6004);
  assert.ok((await register(ctx, { uri: 'h'.repeat(256) })).ok, '256-byte URI is allowed');
  const again = await register(ctx);
  assert.equal(again.ok, false, 'same creator + nonce cannot register twice');
  assert.ok((await register(ctx, { nonce: 1n })).ok, 'next nonce works');
});

test('update_manifest: authority only, bumps revision', async () => {
  const ctx = await setup();
  await register(ctx);
  const ok = await send(ctx.svm, ctx.creator, [
    getUpdateManifestInstruction({ appRecord: ctx.appId, authority: ctx.creator, manifestUri: URI_B, manifestHash: HASH_B }),
  ]);
  assert.ok(ok.ok);
  let rec = (await fetchMaybeAppRecord(ctx.rpc, ctx.appId)) as { exists: true; data: { revision: number; manifestUri: string } };
  assert.equal(rec.data.revision, 1);
  assert.equal(rec.data.manifestUri, URI_B);

  const stranger = await fundedSigner(ctx.svm);
  expectAnchorError(
    await send(ctx.svm, stranger, [
      getUpdateManifestInstruction({ appRecord: ctx.appId, authority: stranger, manifestUri: URI_A, manifestHash: HASH_A }),
    ]),
    6005,
  );
  expectAnchorError(
    await send(ctx.svm, ctx.creator, [
      getUpdateManifestInstruction({ appRecord: ctx.appId, authority: ctx.creator, manifestUri: URI_A, manifestHash: new Uint8Array(32) }),
    ]),
    6003,
  );
  rec = (await fetchMaybeAppRecord(ctx.rpc, ctx.appId)) as typeof rec;
  assert.equal(rec.data.revision, 1, 'failed updates do not change revision');
});

test('two-step authority transfer, cancel, and guards', async () => {
  const ctx = await setup();
  await register(ctx);
  const next = await fundedSigner(ctx.svm);
  const other = await fundedSigner(ctx.svm);

  expectAnchorError(await send(ctx.svm, ctx.creator, [getProposeAuthorityInstruction({ appRecord: ctx.appId, authority: ctx.creator, newAuthority: ctx.creator.address })]), 6007);
  expectAnchorError(await send(ctx.svm, next, [getAcceptAuthorityInstruction({ appRecord: ctx.appId, newAuthority: next })]), 6006);

  assert.ok((await send(ctx.svm, ctx.creator, [getProposeAuthorityInstruction({ appRecord: ctx.appId, authority: ctx.creator, newAuthority: next.address })])).ok);
  expectAnchorError(await send(ctx.svm, other, [getAcceptAuthorityInstruction({ appRecord: ctx.appId, newAuthority: other })]), 6005);

  // Cancel with all zeros, then accept must fail.
  assert.ok((await send(ctx.svm, ctx.creator, [getProposeAuthorityInstruction({ appRecord: ctx.appId, authority: ctx.creator, newAuthority: ZERO })])).ok);
  expectAnchorError(await send(ctx.svm, next, [getAcceptAuthorityInstruction({ appRecord: ctx.appId, newAuthority: next })]), 6006);

  // Propose again and accept.
  assert.ok((await send(ctx.svm, ctx.creator, [getProposeAuthorityInstruction({ appRecord: ctx.appId, authority: ctx.creator, newAuthority: next.address })])).ok);
  assert.ok((await send(ctx.svm, next, [getAcceptAuthorityInstruction({ appRecord: ctx.appId, newAuthority: next })])).ok);
  const rec = (await fetchMaybeAppRecord(ctx.rpc, ctx.appId)) as { exists: true; data: { authority: Address; pendingAuthority: Address } };
  assert.equal(rec.data.authority, next.address);
  assert.equal(rec.data.pendingAuthority, ZERO);

  // Old authority has lost control.
  expectAnchorError(
    await send(ctx.svm, ctx.creator, [getUpdateManifestInstruction({ appRecord: ctx.appId, authority: ctx.creator, manifestUri: URI_B, manifestHash: HASH_B })]),
    6005,
  );
});

test('set_status: Deprecated stays updatable; Retired is terminal and clears pending authority', async () => {
  const ctx = await setup();
  await register(ctx);
  const next = await fundedSigner(ctx.svm);

  expectAnchorError(await send(ctx.svm, ctx.creator, [getSetStatusInstruction({ appRecord: ctx.appId, authority: ctx.creator, status: 3 })]), 6009);
  assert.ok((await send(ctx.svm, ctx.creator, [getSetStatusInstruction({ appRecord: ctx.appId, authority: ctx.creator, status: AppStatus.Deprecated })])).ok);
  assert.ok((await send(ctx.svm, ctx.creator, [getUpdateManifestInstruction({ appRecord: ctx.appId, authority: ctx.creator, manifestUri: URI_B, manifestHash: HASH_B })])).ok);

  assert.ok((await send(ctx.svm, ctx.creator, [getProposeAuthorityInstruction({ appRecord: ctx.appId, authority: ctx.creator, newAuthority: next.address })])).ok);
  assert.ok((await send(ctx.svm, ctx.creator, [getSetStatusInstruction({ appRecord: ctx.appId, authority: ctx.creator, status: AppStatus.Retired })])).ok);

  const rec = (await fetchMaybeAppRecord(ctx.rpc, ctx.appId)) as { exists: true; data: { status: number; pendingAuthority: Address } };
  assert.equal(rec.data.status, AppStatus.Retired);
  assert.equal(rec.data.pendingAuthority, ZERO);

  expectAnchorError(await send(ctx.svm, ctx.creator, [getUpdateManifestInstruction({ appRecord: ctx.appId, authority: ctx.creator, manifestUri: URI_A, manifestHash: HASH_A })]), 6008);
  expectAnchorError(await send(ctx.svm, ctx.creator, [getSetStatusInstruction({ appRecord: ctx.appId, authority: ctx.creator, status: AppStatus.Active })]), 6008);
  expectAnchorError(await send(ctx.svm, ctx.creator, [getProposeAuthorityInstruction({ appRecord: ctx.appId, authority: ctx.creator, newAuthority: next.address })]), 6008);
  expectAnchorError(await send(ctx.svm, next, [getAcceptAuthorityInstruction({ appRecord: ctx.appId, newAuthority: next })]), 6008);
});
