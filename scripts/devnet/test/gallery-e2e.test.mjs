import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateStatus, remainingSignedSteps } from '../gallery-e2e.mjs';

const verified = [{ state: 'verified' }, { state: 'verified' }];

test('remaining signed steps follow observed state, never assumptions', () => {
  assert.match(remainingSignedSteps({ registered: false, recordManifestMatches: false, programs: [] })[0], /creator wallet signs/);
  assert.match(remainingSignedSteps({ registered: true, recordManifestMatches: false, programs: [] })[0], /record authority signs a manifest update/);
  assert.deepEqual(remainingSignedSteps({ registered: true, recordManifestMatches: true, programs: [{ program: 'P', backlink: 'verified' }] }), []);
  const [link] = remainingSignedSteps({ registered: true, recordManifestMatches: true, programs: [{ program: 'P', backlink: 'unverified', upgradeAuthority: 'A' }] });
  assert.match(link, /upgrade authority A signs/);
  const [frozen] = remainingSignedSteps({ registered: true, recordManifestMatches: true, programs: [{ program: 'P', backlink: 'unverified', upgradeAuthority: null }] });
  assert.match(frozen, /attestation/);
});

test('the gate is PASS only for a registered, matching record with every claim verified', () => {
  const base = { preflightErrors: [], registered: true, recordManifestMatches: true, claims: verified, remaining: [] };
  assert.equal(gateStatus(base), 'PASS');
  assert.equal(gateStatus({ ...base, registered: false, remaining: ['x'] }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, recordManifestMatches: false, remaining: ['x'] }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, claims: [{ state: 'unverified' }] }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, claims: [{ state: 'attested' }] }), 'BLOCKED', 'attested is not reciprocal evidence');
  assert.equal(gateStatus({ ...base, claims: [{ state: 'failed' }] }), 'FAIL');
  assert.equal(gateStatus({ ...base, preflightErrors: ['manifest URI: mutable'] }), 'FAIL');
});
