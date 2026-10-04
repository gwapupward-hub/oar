import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declaredProgramId } from '../devnet/lib.mjs';
import { devnetComparison, releaseErrors, releaseNotes, sha256sums, versionMismatches } from '../release.mjs';

const ID = declaredProgramId();
const SHA = 'a'.repeat(40);
const build = { repo_sha: SHA, program_id: ID, double_build_match: true, executable_hash: 'exe', artifact_sha256: 'art' };
const devnet = { programId: ID, build: { repo_sha: 'b'.repeat(40) }, deployment: { onchainExecutableHash: 'exe' } };

test('the release version must be written everywhere it appears', () => {
  const pkg = v => JSON.stringify({ version: v, dependencies: { '@open-app-registry/sdk': v } });
  const files = { 'package.json': pkg('1.0.0'), 'packages/sdk/package.json': pkg('1.0.0'), 'packages/cli/package.json': pkg('1.0.0'),
    'packages/cli/src/index.ts': ".version('1.0.0');" };
  assert.deepEqual(versionMismatches('1.0.0', p => files[p]), []);
  files['packages/cli/src/index.ts'] = ".version('0.9.0');";
  assert.deepEqual(versionMismatches('1.0.0', p => files[p]), ['packages/cli/src/index.ts (--version) has 0.9.0']);
  files['packages/cli/src/index.ts'] = ".version('1.0.0');";
  files['packages/cli/package.json'] = JSON.stringify({ version: '1.0.0', dependencies: { '@open-app-registry/sdk': '1.0.1' } });
  assert.deepEqual(versionMismatches('1.0.0', p => files[p]), ['packages/cli/package.json (SDK dependency) has 1.0.1']);
});

test('the artifact must come from the released commit, reproduce, and carry the declared program ID', () => {
  assert.deepEqual(releaseErrors('0.1.1-rc.1', build, SHA), []);
  assert.match(releaseErrors('0.1.1-rc.1', build, 'c'.repeat(40)).join(), /built from a+, not c+/);
  assert.match(releaseErrors('0.1.1-rc.1', { ...build, double_build_match: false }, SHA).join(), /second clean build/);
  assert.match(releaseErrors('0.1.1-rc.1', { ...build, program_id: 'other' }, SHA).join(), /differs from declare_id!/);
  assert.match(releaseErrors('v0.1.1', build, SHA).join(), /not a semantic version/);
});

test('an unchanged program must reproduce the deployed devnet executable', () => {
  assert.equal(devnetComparison(build, devnet, false).matchesDevnet, true);
  assert.equal(devnetComparison(build, devnet, false).error, null);
  const drifted = devnetComparison({ ...build, executable_hash: 'other' }, devnet, false);
  assert.equal(drifted.matchesDevnet, false);
  assert.match(drifted.error, /unchanged since b+, but executable hash other differs from the deployed exe/);
  const changed = devnetComparison({ ...build, executable_hash: 'other' }, devnet, true);
  assert.deepEqual([changed.matchesDevnet, changed.error], [false, null], 'a changed program is reported, not blocked');
  assert.deepEqual([devnetComparison(build, {}, true).matchesDevnet, devnetComparison(build, {}, true).error], [false, null]);
});

test('checksums cover every asset except themselves, sorted by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oar-release-'));
  writeFileSync(join(dir, 'b.txt'), 'b');
  writeFileSync(join(dir, 'a.txt'), 'a');
  writeFileSync(join(dir, 'SHA256SUMS'), 'stale');
  assert.equal(sha256sums(dir),
    'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  a.txt\n' +
    '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.txt\n');
});

test('release notes state whether the binary is the deployed devnet program', () => {
  const m = { tag: 'v0.1.1-rc.1', commit: SHA, programId: ID, builderImage: 'img@sha256:x', artifactSha256: 'art', executableHash: 'exe',
    idlSha256: 'idl', doubleBuildMatch: true, ciRunUrl: 'https://ci', devnet: devnetComparison(build, devnet, false) };
  const notes = releaseNotes(m, 'sum  oar_registry.so\n');
  assert.match(notes, /Same binary as devnet \| Yes: identical to the program deployed on devnet at `\w+` \(built from `bbbbbbb`\)/);
  assert.match(notes, /```\nsum  oar_registry\.so\n```/);
  assert.match(releaseNotes({ ...m, devnet: devnetComparison({ ...build, executable_hash: 'new' }, devnet, true) }, ''), /No: this binary is not the one deployed on devnet/);
});
