import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner, getAddressEncoder } from '@solana/kit';
import * as sas from 'sas-lib';
import {
  ATTESTATION_APP_ID_OFFSET,
  OAR_SCHEMAS,
  decodeAttestation,
  deriveAttestationNonce,
  deriveAttestationPda,
  deriveCredentialPda,
  deriveSchemaPda,
} from '../src/index.js';

test('PDA derivations match the official sas-lib client', async () => {
  const authority = (await generateKeyPairSigner()).address;
  const credential = await deriveCredentialPda(authority, 'oar-reference');
  const [sasCredential] = await sas.deriveCredentialPda({ authority, name: 'oar-reference' });
  assert.equal(credential, sasCredential);

  for (const name of Object.keys(OAR_SCHEMAS) as (keyof typeof OAR_SCHEMAS)[]) {
    const schema = await deriveSchemaPda(credential, name, OAR_SCHEMAS[name].version);
    const [sasSchema] = await sas.deriveSchemaPda({ credential, name, version: OAR_SCHEMAS[name].version });
    assert.equal(schema, sasSchema, name);

    const nonce = deriveAttestationNonce(name, authority, 'subject', { appCluster: 'solana:devnet' });
    const [sasAttestation] = await sas.deriveAttestationPda({ credential, schema, nonce });
    assert.equal(await deriveAttestationPda(credential, schema, nonce), sasAttestation);
  }
});

test('decodeAttestation reads accounts encoded by sas-lib, and app_id sits at offset 105', async () => {
  const appId = (await generateKeyPairSigner()).address;
  const credential = (await generateKeyPairSigner()).address;
  const schema = (await generateKeyPairSigner()).address;
  const nonce = deriveAttestationNonce('oar-repo', appId, 'https://github.com/a/b', { appCluster: 'solana:devnet' });
  const data = sas.serializeAttestationData(
    {
      layout: Uint8Array.from(OAR_SCHEMAS['oar-repo'].layout),
      fieldNames: Uint8Array.from(
        OAR_SCHEMAS['oar-repo'].fields.flatMap(f => [f.length, 0, 0, 0, ...new TextEncoder().encode(f)]),
      ),
    } as never,
    { app_id: Array.from(getAddressEncoder().encode(appId)), app_cluster: 'solana:devnet', url: 'https://github.com/a/b', checked_at: 1n },
  );
  const bytes = Uint8Array.from(
    sas.getAttestationEncoder().encode({
      discriminator: 2,
      nonce,
      credential,
      schema,
      data,
      signer: credential,
      expiry: 123n,
      tokenAccount: '11111111111111111111111111111111' as never,
    }),
  );
  const d = decodeAttestation(bytes);
  assert.equal(d.nonce, nonce);
  assert.equal(d.credential, credential);
  assert.equal(d.schema, schema);
  assert.equal(d.signer, credential);
  assert.equal(d.expiry, 123n);
  assert.deepEqual(bytes.slice(ATTESTATION_APP_ID_OFFSET, ATTESTATION_APP_ID_OFFSET + 32), Uint8Array.from(getAddressEncoder().encode(appId)));
});

test('nonce derivation is deterministic and subject-specific', () => {
  const app = '9bN34ZdBQQdEQEyBhNLmAPrcgjuAvCPfVW41AVbP6nmD';
  assert.equal(deriveAttestationNonce('oar-domain', app, 'gwapspot.fun', { appCluster: 'solana:devnet' }), deriveAttestationNonce('oar-domain', app, 'gwapspot.fun', { appCluster: 'solana:devnet' }));
  assert.notEqual(deriveAttestationNonce('oar-domain', app, 'gwapspot.fun', { appCluster: 'solana:devnet' }), deriveAttestationNonce('oar-domain', app, 'www.gwapspot.fun', { appCluster: 'solana:devnet' }));
  assert.notEqual(deriveAttestationNonce('oar-domain', app, 'x', { appCluster: 'solana:devnet' }), deriveAttestationNonce('oar-repo', app, 'x', { appCluster: 'solana:devnet' }));
});
