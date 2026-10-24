// Every non-signing step of the developer journey on devnet, with recorded evidence. Read-only: it sends no
// transaction, reads no keypair and needs no secret. Whatever still needs a signature is listed, not done.
//
//   node scripts/devnet/gallery-e2e.mjs --creator <PUBKEY> --domain <host> --repo <url> [--program <id>]...
//       [--nonce <n>] [--manifest <file>] [--manifest-uri <uri>] [--rpc <url>] [--write]
//
// Without --manifest it builds the manifest the starter's `oar:prepare` would build from the same inputs.
// --write saves the evidence under release/evidence/. The exit code is 0 only when the gate is PASS.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_RPC, readJson, root, rpcHost, writeJson } from './lib.mjs';

const CLUSTER = 'solana:devnet';

/** What a person still has to sign, derived from observed state only. */
export function remainingSignedSteps({ registered, recordManifestMatches, programs }) {
  const steps = [];
  if (!registered) steps.push('Register the App ID: the creator wallet signs at https://oarprotocol.xyz/register (or `oar claim register --yes`).');
  else if (!recordManifestMatches) steps.push('Point the record at the prepared manifest: the record authority signs a manifest update (Update card, or `oar update`).');
  for (const p of programs) {
    if (p.backlink === 'verified') continue;
    steps.push(p.upgradeAuthority
      ? `Link ${p.program}: its upgrade authority ${p.upgradeAuthority} signs the canonical \`oar\` backlink (\`oar claim link-program ${p.program}\`, or --squads).`
      : `Link ${p.program}: no upgrade authority, so only a trusted issuer attestation can vouch for it.`);
  }
  return steps;
}

/** PASS requires the hosted manifest and every declared reciprocal link to resolve, not just an empty claim list. */
export function gateStatus({ preflightErrors, hosting, registered, recordManifestMatches, resolved, expectedClaims, claims, remaining }) {
  if (preflightErrors.length || hosting?.reason === 'different' || hosting?.reason === 'unsafe-uri') return 'FAIL';
  if (['hash-mismatch', 'schema', 'app-id-mismatch', 'cluster-mismatch'].includes(resolved?.manifest)) return 'FAIL';
  if (claims.some(c => c.state === 'failed')) return 'FAIL';
  if (!registered || !recordManifestMatches || remaining.length) return 'BLOCKED';
  if (!hosting?.ok || !resolved || resolved.manifest !== 'ok' || resolved.status !== 'Active') return 'BLOCKED';
  if (!Array.isArray(expectedClaims) || !expectedClaims.length || claims.length !== expectedClaims.length) return 'BLOCKED';
  const expected = expectedClaims.map(c => `${c.kind}:${c.subject}`).sort();
  const observed = claims.map(c => `${c.kind}:${c.subject}`).sort();
  if (expected.some((key, i) => key !== observed[i])) return 'BLOCKED';
  if (claims.some(c => c.state !== 'verified')) return 'BLOCKED';
  return 'PASS';
}

async function main() {
  const { values: o } = parseArgs({
    options: {
      creator: { type: 'string' }, domain: { type: 'string' }, repo: { type: 'string', multiple: true, default: [] },
      program: { type: 'string', multiple: true, default: [] }, nonce: { type: 'string', default: '0' },
      manifest: { type: 'string' }, 'manifest-uri': { type: 'string' }, rpc: { type: 'string', default: DEFAULT_RPC },
      write: { type: 'boolean', default: false },
    },
  });
  if (!o.creator) throw new Error('--creator <PUBLIC_KEY> is required');
  const sdk = await import('@open-app-registry/sdk');
  const { address, createSolanaRpc } = await import('@solana/kit');
  const rpc = createSolanaRpc(o.rpc);
  const appId = await sdk.findAppId({ creator: address(o.creator), nonce: BigInt(o.nonce) });

  // 1-4. Prepare and validate the manifest; enforce immutable hosting.
  let manifest, manifestUri;
  if (o.manifest) {
    manifest = sdk.parseJsonStrict(readFileSync(o.manifest, 'utf8'));
    manifestUri = o['manifest-uri'];
    if (!manifestUri) throw new Error('--manifest needs --manifest-uri');
  } else {
    const files = sdk.buildClaimFiles({
      appId, cluster: CLUSTER, name: 'Gallery E2E', domains: o.domain ? [o.domain] : [], repositories: o.repo,
      programs: o.program.map(p => address(p)), manifestUri: o['manifest-uri'],
    });
    ({ manifest, manifestUri } = files);
  }
  const preflightErrors = [];
  const schema = sdk.validateManifest(manifest);
  if (!schema.valid) preflightErrors.push(`manifest schema: ${schema.errors.join('; ')}`);
  if (manifest.app_id !== appId) preflightErrors.push(`manifest app_id ${manifest.app_id} is not the derived ${appId}`);
  const uriPolicy = sdk.checkManifestUri(manifestUri);
  if (!uriPolicy.ok) preflightErrors.push(`manifest URI: ${uriPolicy.detail}`);
  const hosting = await sdk.checkManifestHosting(manifestUri, manifest);

  // 5. Domain and repository proofs, live.
  const domains = [];
  for (const host of manifest.domains ?? []) domains.push({ subject: host, ...(await sdk.checkDomain(host, appId, CLUSTER)) });
  const repositories = [];
  for (const r of manifest.repositories ?? []) repositories.push({ subject: r.url, ...(await sdk.checkRepository(r.url, appId, CLUSTER)) });

  // 7. Program backlinks and who must sign them.
  const programs = [];
  for (const p of manifest.programs ?? []) {
    const program = address(p.address);
    const backlink = sdk.backlinkMatches(await sdk.fetchProgramBacklink(rpc, program), appId, CLUSTER);
    const owner = await sdk.getProgramUpgradeAuthority(rpc, program).catch(() => null);
    programs.push({ program, backlink: backlink.state, detail: backlink.detail, retryable: backlink.retryable, deployed: !!owner, upgradeAuthority: owner?.authority ?? null });
  }

  // 6, 8-9. Record state and the live verifier's view.
  const record = await sdk.fetchMaybeAppRecord(rpc, appId);
  const registered = record.exists;
  const wantedHash = sdk.hashManifestHex(manifest);
  const recordHash = registered ? Buffer.from(record.data.manifestHash).toString('hex') : null;
  const recordManifestMatches = registered && recordHash === wantedHash && record.data.manifestUri === manifestUri;
  let resolved = null;
  if (registered) {
    const app = await sdk.resolveApp(rpc, appId, { cluster: CLUSTER, trustedIssuers: [] });
    resolved = app && {
      status: app.status, manifest: app.manifest.ok ? 'ok' : app.manifest.reason,
      claims: [...app.programs.map(c => ({ kind: 'program', ...c })), ...app.domains.map(c => ({ kind: 'domain', ...c })),
        ...app.repositories.map(c => ({ kind: 'repository', ...c }))]
        .map(c => ({ kind: c.kind, subject: c.subject, state: c.state, method: c.method ?? null, detail: c.detail ?? null, retryable: c.retryable ?? false })),
    };
  }
  const expectedClaims = [...(manifest.programs ?? []).map(p => ({ kind: 'program', subject: p.address })),
    ...(manifest.domains ?? []).map(host => ({ kind: 'domain', subject: host })),
    ...(manifest.repositories ?? []).map(r => ({ kind: 'repository', subject: r.url }))];
  const claims = recordManifestMatches && resolved?.manifest === 'ok' ? resolved.claims
    : [...programs.map(p => ({ kind: 'program', subject: p.program, state: p.backlink })),
      ...domains.map(d => ({ kind: 'domain', subject: d.subject, state: d.state })),
      ...repositories.map(r => ({ kind: 'repository', subject: r.subject, state: r.state }))];
  const remaining = remainingSignedSteps({ registered, recordManifestMatches, programs });

  // 10. Evidence.
  const git = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
  const evidence = {
    kind: 'gallery e2e (non-signing steps only)',
    at: new Date().toISOString(),
    slot: (await rpc.getSlot({ commitment: 'finalized' }).send()).toString(),
    rpcHost: rpcHost(o.rpc),
    sourceCommit: git(['rev-parse', 'HEAD']),
    sourceDirty: git(['status', '--porcelain']) !== '',
    versions: { node: process.version, sdk: readJson(join(root, 'packages/sdk/package.json')).version },
    appId, creator: o.creator, nonce: o.nonce, cluster: CLUSTER,
    manifest: { uri: manifestUri, sha256: wantedHash, schemaValid: schema.valid, uriPolicy, hosting },
    record: registered ? { manifestUri: record.data.manifestUri, manifestSha256: recordHash, revision: record.data.revision, authority: record.data.authority, matchesPrepared: recordManifestMatches } : null,
    domains, repositories, programs, resolved, claims,
    preflightErrors, remainingSignedSteps: remaining,
    gate: gateStatus({ preflightErrors, hosting, registered, recordManifestMatches, resolved, expectedClaims, claims, remaining }),
    transactionSignatures: [],
    note: 'No transaction was sent. Signatures for the remaining steps are added by the person who signs them.',
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (o.write) {
    mkdirSync(join(root, 'release/evidence'), { recursive: true });
    const file = join(root, 'release/evidence', `gallery-e2e-${evidence.at.slice(0, 10)}-${appId.slice(0, 8)}.json`);
    writeJson(file, evidence);
    console.error(`Wrote ${relative(root, file)}`);
  }
  if (evidence.gate !== 'PASS') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`gallery-e2e: ${e.message}`); process.exit(2); });
}
