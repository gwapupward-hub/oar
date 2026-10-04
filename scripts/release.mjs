// Release helper for .github/workflows/release.yml. Public data only; it never reads or produces signer material.
//
//   node scripts/release.mjs check <version>
//       The version must equal every package version, the CLI's --version and the CLI's SDK dependency.
//   node scripts/release.mjs assemble <version> --artifact-dir <dir> --out <dir>
//       Collects the CI-built program, the IDL, the npm tarballs, a reproducible source archive and the devnet
//       records; writes release-manifest.json, SHA256SUMS and the release notes.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { declaredProgramId, executableHash, readJson, root, sha256, writeJson } from './devnet/lib.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
// A program change since the devnet build means the release binary is not the deployed one.
const PROGRAM_PATHS = ['programs', 'Cargo.toml', 'Cargo.lock'];

/** Every place the release version is written. */
export function versionMismatches(version, read = p => readFileSync(join(root, p), 'utf8')) {
  const found = {
    'package.json': JSON.parse(read('package.json')).version,
    'packages/sdk/package.json': JSON.parse(read('packages/sdk/package.json')).version,
    'packages/cli/package.json': JSON.parse(read('packages/cli/package.json')).version,
    'packages/cli/package.json (SDK dependency)': JSON.parse(read('packages/cli/package.json')).dependencies['@open-app-registry/sdk'],
    'packages/cli/src/index.ts (--version)': read('packages/cli/src/index.ts').match(/\.version\('([^']+)'\)/)?.[1],
  };
  return Object.entries(found).filter(([, v]) => v !== version).map(([where, v]) => `${where} has ${v ?? 'no version'}`);
}

/**
 * Compare the CI build with the devnet deployment. When no program source changed since the devnet build, the
 * deterministic build must reproduce the deployed executable exactly; anything else is a failure.
 */
export function devnetComparison(build, devnet, programChanged) {
  const deployed = devnet?.deployment?.onchainExecutableHash ?? null;
  const out = { deployedProgramId: devnet?.programId ?? null, deployedExecutableHash: deployed, devnetBuildCommit: devnet?.build?.repo_sha ?? null, programChangedSinceDevnet: programChanged };
  if (!deployed) return { ...out, matchesDevnet: false, error: null };
  const matchesDevnet = build.executable_hash === deployed && build.program_id === devnet.programId;
  const error = !programChanged && !matchesDevnet
    ? `program sources are unchanged since ${out.devnetBuildCommit}, but executable hash ${build.executable_hash} differs from the deployed ${deployed}`
    : null;
  return { ...out, matchesDevnet, error };
}

export function releaseErrors(version, build, commit) {
  const errors = [];
  if (!SEMVER.test(version)) errors.push(`${version} is not a semantic version`);
  if (build.repo_sha !== commit) errors.push(`artifact was built from ${build.repo_sha}, not ${commit}`);
  if (build.double_build_match !== true) errors.push('artifact did not reproduce in a second clean build');
  if (build.program_id !== declaredProgramId()) errors.push(`artifact program ID ${build.program_id} differs from declare_id!`);
  return errors;
}

export function sha256sums(dir) {
  return readdirSync(dir).filter(f => f !== 'SHA256SUMS').sort()
    .map(f => `${sha256(readFileSync(join(dir, f)))}  ${f}`).join('\n') + '\n';
}

const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const fail = message => { console.error(`RELEASE BLOCKED: ${message}`); process.exit(1); };

function check(version) {
  if (!SEMVER.test(version ?? '')) fail(`${version} is not a semantic version`);
  const mismatches = versionMismatches(version);
  if (mismatches.length) fail(`version ${version} is not set everywhere:\n  ${mismatches.join('\n  ')}`);
  if (!existsSync(join(root, 'release/notes', `v${version}.md`))) fail(`release/notes/v${version}.md is missing`);
  console.log(`Version ${version} is consistent across the packages and the CLI.`);
}

function assemble(version, o) {
  const commit = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']);
  const build = readJson(join(o['artifact-dir'], 'build-metadata.json'));
  const so = readFileSync(join(o['artifact-dir'], 'oar_registry.so'));
  if (executableHash(so) !== build.executable_hash || sha256(so) !== build.artifact_sha256) fail('oar_registry.so does not match build-metadata.json');
  const errors = releaseErrors(version, build, commit);
  const devnet = readJson(join(root, 'release/devnet.json'));
  const changed = devnet.build?.repo_sha
    ? git(['diff', '--name-only', devnet.build.repo_sha, commit, '--', ...PROGRAM_PATHS]) !== ''
    : true;
  const comparison = devnetComparison(build, devnet, changed);
  if (comparison.error) errors.push(comparison.error);
  if (errors.length) fail(errors.join('\n  '));

  const out = o.out;
  mkdirSync(out, { recursive: true });
  copyFileSync(join(o['artifact-dir'], 'oar_registry.so'), join(out, 'oar_registry.so'));
  copyFileSync(join(o['artifact-dir'], 'build-metadata.json'), join(out, 'build-metadata.json'));
  copyFileSync(join(root, 'idl/oar_registry.json'), join(out, 'oar_registry.idl.json'));
  copyFileSync(join(root, 'release/devnet.json'), join(out, 'devnet.json'));
  copyFileSync(join(root, 'release/gwap-release-record.devnet.json'), join(out, 'gwap-release-record.devnet.json'));
  execFileSync('npm', ['pack', '-w', '@open-app-registry/sdk', '-w', '@open-app-registry/cli', '--pack-destination', out], { cwd: root, stdio: 'inherit' });
  execFileSync('python3', [join(root, 'scripts/package-release.py'), join(out, `open-app-registry-${version}-source.zip`)], { cwd: root, stdio: 'inherit' });
  if (o['dependency-report']) {
    for (const f of readdirSync(o['dependency-report'])) copyFileSync(join(o['dependency-report'], f), join(out, `dependency-${f}`));
  }

  const manifest = {
    version,
    tag: `v${version}`,
    commit,
    programId: build.program_id,
    builderImage: build.builder_image,
    toolVersions: build.tool_versions,
    artifactSha256: build.artifact_sha256,
    executableHash: build.executable_hash,
    idlSha256: build.idl_sha256,
    doubleBuildMatch: build.double_build_match,
    ciRunUrl: build.ci_run_url,
    devnet: comparison,
    mainnet: 'NO-GO',
  };
  writeJson(join(out, 'release-manifest.json'), manifest);
  writeFileSync(join(out, 'SHA256SUMS'), sha256sums(out));
  writeFileSync(o.notes, releaseNotes(manifest, readFileSync(join(out, 'SHA256SUMS'), 'utf8')));
  console.log(`Assembled ${version} at ${commit} in ${out}`);
}

export function releaseNotes(m, sums) {
  const notes = readFileSync(join(root, 'release/notes', `${m.tag}.md`), 'utf8').trimEnd();
  const devnet = m.devnet.matchesDevnet
    ? `Yes: identical to the program deployed on devnet at \`${m.devnet.deployedProgramId}\` (built from \`${m.devnet.devnetBuildCommit?.slice(0, 7)}\`).`
    : 'No: this binary is not the one deployed on devnet.';
  return `${notes}

## Build

| Item | Value |
| --- | --- |
| Commit | \`${m.commit}\` |
| Program ID | \`${m.programId}\` |
| Builder | \`${m.builderImage}\` |
| \`oar_registry.so\` SHA-256 | \`${m.artifactSha256}\` |
| Executable hash | \`${m.executableHash}\` |
| IDL SHA-256 | \`${m.idlSha256}\` |
| Second clean build identical | ${m.doubleBuildMatch ? 'Yes' : 'No'} |
| Same binary as devnet | ${devnet} |
| CI run | ${m.ciRunUrl} |

## SHA256SUMS

\`\`\`
${sums.trimEnd()}
\`\`\`
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { positionals: [cmd, version], values: o } = parseArgs({
    allowPositionals: true,
    options: { 'artifact-dir': { type: 'string' }, out: { type: 'string' }, notes: { type: 'string' }, 'dependency-report': { type: 'string' } },
  });
  if (cmd === 'check') check(version);
  else if (cmd === 'assemble') {
    for (const k of ['artifact-dir', 'out', 'notes']) if (!o[k]) fail(`--${k} is required`);
    check(version);
    assemble(version, o);
  } else fail('usage: release.mjs check <version> | assemble <version> --artifact-dir <dir> --out <dir> --notes <file>');
}
