#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command, Option } from 'commander';
import { address, createNoopSigner, type Address, type KeyPairSigner } from '@solana/kit';
import {
  AppStatus,
  assertRegistrationInstructions,
  backlinkMatches,
  buildClaimFiles,
  buildProgramLink,
  buildProofFile,
  bytesEqual,
  checkDomain,
  checkManifestHosting,
  checkRepository,
  describeProgramLink,
  describeRegistration,
  exportUnsignedTransaction,
  fetchMaybeAppRecord,
  fetchProgramBacklink,
  findAppId,
  getAcceptAuthorityInstruction,
  getProgramLinkInstructions,
  getProgramUpgradeAuthority,
  getProposeAuthorityInstruction,
  getRegisterInstructionAsync,
  getSetStatusInstruction,
  getUpdateManifestInstruction,
  hashManifest,
  hashManifestHex,
  nextAppNonce,
  parseJsonStrict,
  resolveApp,
  resolveProgram,
  validateManifest,
  type Category,
  type Cluster,
  type OarManifest,
  type ResolvedApp,
} from '@open-app-registry/sdk';
import { loadKeypair, parseCluster, rpcFor, sendAndConfirm } from './tx.js';

const program = new Command()
  .name('oar')
  .description('Open App Registry: onchain application identity for Solana')
  .version('0.1.1-rc.2');

const clusterOpt = () => new Option('-c, --cluster <cluster>', 'mainnet | devnet | testnet').default('devnet');
const rpcOpt = () => new Option('-u, --rpc <url>', 'RPC URL (defaults to the public endpoint for the cluster)');
const keypairOpt = () => new Option('-k, --keypair <path>', 'signer keypair file').default(undefined, '~/.config/solana/id.json');

/** Manifests and proof files are read strictly: a repeated key is an error, never silently merged. */
function readJson(path: string): unknown {
  return parseJsonStrict(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: unknown, force = false): void {
  if (existsSync(path) && !force) throw new Error(`${path} exists (use --force to overwrite)`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function loadValidManifest(path: string, expected?: { appId: string; cluster: Cluster }): OarManifest {
  const manifest = readJson(path);
  const v = validateManifest(manifest);
  if (!v.valid) throw new Error(`Manifest is invalid:\n  ${v.errors.join('\n  ')}`);
  const m = manifest as OarManifest;
  if (expected && m.app_id !== expected.appId) {
    throw new Error(`manifest app_id is ${m.app_id} but the App ID is ${expected.appId}. Set "app_id" to ${expected.appId}.`);
  }
  if (expected && m.cluster !== expected.cluster) {
    throw new Error(`manifest cluster is ${m.cluster} but you are targeting ${expected.cluster}.`);
  }
  return m;
}

const mark = { verified: '✓', attested: '✓', unverified: '·', failed: '✗' } as const;

function printApp(app: ResolvedApp): void {
  const r = app.record;
  const m = app.manifest;
  console.log(`App ID     ${app.appId} (${app.cluster})`);
  console.log(`Status     ${app.status}   revision ${r.revision}`);
  console.log(`Authority  ${r.authority}${r.pendingAuthority !== '11111111111111111111111111111111' ? `  (pending: ${r.pendingAuthority})` : ''}`);
  console.log(`Manifest   ${r.manifestUri}`);
  if (!m.ok) {
    const why = m.reason === 'unavailable' ? m.errors.join('; ') : m.reason;
    console.log(`           metadata unavailable (${why})`);
    return;
  }
  const verified = [...app.programs, ...app.domains].some(c => c.state === 'verified' || c.state === 'attested');
  console.log(`Name       ${verified ? '' : 'Unverified: '}${m.manifest.name}`);
  const row = (kind: string, c: { subject: string; state: keyof typeof mark; detail?: string; attestedBy: Address[] }) =>
    console.log(`  ${mark[c.state]} ${kind.padEnd(8)} ${c.subject}  ${c.state}${c.attestedBy.length ? ` by ${c.attestedBy.join(', ')}` : ''}${c.detail && c.state !== 'verified' ? `  (${c.detail})` : ''}`);
  app.programs.forEach(c => row('program', c));
  app.domains.forEach(c => row('domain', c));
  app.repositories.forEach(c => row('repo', c));
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x), 2);

program
  .command('init')
  .description('write a manifest template')
  .option('-o, --out <path>', 'output file', 'oar.manifest.json')
  .option('--app <appId>', 'App ID (see `oar app-id`)')
  .addOption(clusterOpt())
  .option('--force', 'overwrite an existing file')
  .action(o => {
    const template: OarManifest = {
      oar: '0.1',
      app_id: o.app ?? 'REPLACE_WITH_APP_ID',
      cluster: parseCluster(o.cluster),
      name: 'My App',
      summary: 'One sentence about what the app does.',
      categories: ['other'],
      domains: ['example.com'],
      links: { website: 'https://example.com' },
      repositories: [],
      programs: [],
    };
    writeJson(o.out, template, o.force);
    console.log(`Wrote ${o.out}. Edit it, then run: oar validate ${o.out}`);
  });

program
  .command('validate <file>')
  .description('check a manifest against the v0.1 schema')
  .action(file => {
    const v = validateManifest(readJson(file));
    if (!v.valid) {
      console.error(`Invalid:\n  ${v.errors.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('Valid OAR v0.1 manifest');
  });

program
  .command('hash <file>')
  .description('print SHA-256 of the RFC 8785 canonical manifest')
  .action(file => console.log(hashManifestHex(readJson(file))));

program
  .command('app-id')
  .description('derive an App ID before registering')
  .requiredOption('--creator <pubkey>', 'creator (signer of register)')
  .option('--nonce <n>', 'nonce', '0')
  .action(async o => console.log(await findAppId({ creator: address(o.creator), nonce: BigInt(o.nonce) })));

program
  .command('register')
  .description('create an App ID onchain')
  .requiredOption('-m, --manifest <file>', 'manifest file (its app_id must equal the derived App ID)')
  .requiredOption('--uri <uri>', 'where the manifest is hosted (ar://, ipfs:// or https://)')
  .option('--nonce <n>', 'nonce', '0')
  .option('--authority <pubkey>', 'authority (default: the signer; a Squads vault is recommended)')
  .addOption(clusterOpt())
  .addOption(rpcOpt())
  .addOption(keypairOpt())
  .action(async o => {
    const cluster = parseCluster(o.cluster);
    const signer = await loadKeypair(o.keypair);
    const appId = await findAppId({ creator: signer.address, nonce: BigInt(o.nonce) });
    const manifest = loadValidManifest(o.manifest, { appId, cluster });
    const ix = await getRegisterInstructionAsync({
      creator: signer,
      nonce: BigInt(o.nonce),
      authority: o.authority ? address(o.authority) : signer.address,
      manifestUri: o.uri,
      manifestHash: hashManifest(manifest),
    });
    const sig = await sendAndConfirm(rpcFor(cluster, o.rpc), signer, [ix]);
    console.log(`Registered ${appId}\nSignature ${sig}`);
  });

program
  .command('update')
  .description('point an App ID at a new manifest')
  .requiredOption('--app <appId>', 'App ID')
  .requiredOption('-m, --manifest <file>', 'manifest file')
  .requiredOption('--uri <uri>', 'where the manifest is hosted')
  .addOption(clusterOpt())
  .addOption(rpcOpt())
  .addOption(keypairOpt())
  .action(async o => {
    const cluster = parseCluster(o.cluster);
    const signer = await loadKeypair(o.keypair);
    const manifest = loadValidManifest(o.manifest, { appId: o.app, cluster });
    const ix = getUpdateManifestInstruction({
      appRecord: address(o.app),
      authority: signer,
      manifestUri: o.uri,
      manifestHash: hashManifest(manifest),
    });
    console.log(`Signature ${await sendAndConfirm(rpcFor(cluster, o.rpc), signer, [ix])}`);
  });

program
  .command('set-status')
  .description('set Active, Deprecated or Retired (Retired is permanent)')
  .requiredOption('--app <appId>', 'App ID')
  .addOption(new Option('--status <status>').choices(['active', 'deprecated', 'retired']).makeOptionMandatory())
  .option('--yes', 'confirm an irreversible Retired status')
  .addOption(clusterOpt())
  .addOption(rpcOpt())
  .addOption(keypairOpt())
  .action(async o => {
    if (o.status === 'retired' && !o.yes) throw new Error('Retired is permanent: the record can never change again. Re-run with --yes.');
    const status = { active: AppStatus.Active, deprecated: AppStatus.Deprecated, retired: AppStatus.Retired }[o.status as 'active'];
    const cluster = parseCluster(o.cluster);
    const signer = await loadKeypair(o.keypair);
    const ix = getSetStatusInstruction({ appRecord: address(o.app), authority: signer, status });
    console.log(`Signature ${await sendAndConfirm(rpcFor(cluster, o.rpc), signer, [ix])}`);
  });

program
  .command('propose-authority')
  .description('step 1 of an authority transfer (11111111111111111111111111111111 cancels)')
  .requiredOption('--app <appId>', 'App ID')
  .requiredOption('--new <pubkey>', 'proposed authority')
  .addOption(clusterOpt())
  .addOption(rpcOpt())
  .addOption(keypairOpt())
  .action(async o => {
    const cluster = parseCluster(o.cluster);
    const signer = await loadKeypair(o.keypair);
    const ix = getProposeAuthorityInstruction({ appRecord: address(o.app), authority: signer, newAuthority: address(o.new) });
    console.log(`Signature ${await sendAndConfirm(rpcFor(cluster, o.rpc), signer, [ix])}`);
  });

program
  .command('accept-authority')
  .description('step 2: the proposed authority signs to take over')
  .requiredOption('--app <appId>', 'App ID')
  .addOption(clusterOpt())
  .addOption(rpcOpt())
  .addOption(keypairOpt())
  .action(async o => {
    const cluster = parseCluster(o.cluster);
    const signer = await loadKeypair(o.keypair);
    const ix = getAcceptAuthorityInstruction({ appRecord: address(o.app), newAuthority: signer });
    console.log(`Signature ${await sendAndConfirm(rpcFor(cluster, o.rpc), signer, [ix])}`);
  });

program
  .command('link-file')
  .description('write oar-link.json for a program backlink and print the Program Metadata command')
  .requiredOption('--app <appId>', 'App ID')
  .addOption(new Option('-c, --cluster <cluster>', 'cluster where the App ID lives (mainnet | devnet | testnet)').default('devnet'))
  .option('-o, --out <path>', 'output file', 'oar-link.json')
  .option('--force', 'overwrite an existing file')
  .action(o => {
    const cluster = parseCluster(o.cluster);
    writeJson(o.out, buildProgramLink(o.app, cluster), o.force);
    console.log(`Wrote ${o.out}. As the program's upgrade authority, run on the program's cluster:\n`);
    console.log(`  npx @solana-program/program-metadata@0.10.0 write oar <PROGRAM_ID> ./${o.out} --format json -k <UPGRADE_AUTHORITY_KEYPAIR> --rpc <RPC_URL>\n`);
    console.log('For a Squads-controlled program add: --export <VAULT_ADDRESS>');
  });

program
  .command('well-known')
  .description('write .well-known/oar.json (also usable as oar.json at a repo root)')
  .requiredOption('--app <appId...>', 'one or more App IDs')
  .addOption(clusterOpt())
  .option('-o, --out <path>', 'output file', '.well-known/oar.json')
  .option('--force', 'overwrite an existing file')
  .action(o => {
    const cluster = parseCluster(o.cluster);
    writeJson(o.out, buildProofFile((o.app as string[]).map(appId => ({ appId, cluster }))), o.force);
    console.log(`Wrote ${o.out}. Serve it at https://<host>/.well-known/oar.json with no redirects.`);
  });

program
  .command('verify-domain <host>')
  .description('run the domain proof check')
  .requiredOption('--app <appId>', 'App ID')
  .addOption(clusterOpt())
  .action(async (host, o) => {
    const r = await checkDomain(host, o.app, parseCluster(o.cluster));
    console.log(`${mark[r.state]} ${host}: ${r.state}${r.method ? ` via ${r.method}` : ''}${r.detail ? ` (${r.detail})` : ''}`);
    if (r.state !== 'verified') process.exitCode = 1;
  });

const resolveOpts = (cmd: Command) =>
  cmd
    .addOption(clusterOpt())
    .addOption(rpcOpt())
    .option('--issuer <credential...>', 'trusted SAS credential(s) for attestations')
    .option('--no-live', 'skip live HTTP/DNS checks')
    .option('--json', 'print JSON');

resolveOpts(program.command('inspect <appId>').description('resolve an App ID and check every link')).action(async (appId, o) => {
  const cluster = parseCluster(o.cluster);
  const rpc = rpcFor(cluster, o.rpc);
  const app = await resolveApp(rpc, address(appId), {
    cluster,
    live: o.live,
    trustedIssuers: (o.issuer ?? []).map((a: string) => address(a)),
  });
  if (!app) {
    const raw = await fetchMaybeAppRecord(rpc, address(appId));
    console.error(raw.exists ? 'Account exists but is not an OAR AppRecord' : `No AppRecord at ${appId} on ${cluster}`);
    process.exitCode = 1;
    return;
  }
  if (o.json) console.log(json(app));
  else printApp(app);
});

resolveOpts(program.command('resolve-program <program>').description('find the app behind a program')).action(async (prog, o) => {
  const cluster = parseCluster(o.cluster);
  const r = await resolveProgram(rpcFor(cluster, o.rpc), address(prog), {
    cluster,
    live: o.live,
    trustedIssuers: (o.issuer ?? []).map((a: string) => address(a)),
  });
  if (!r) {
    console.error(`No valid oar backlink for ${prog} on ${cluster}`);
    process.exitCode = 1;
    return;
  }
  if (o.json) console.log(json(r));
  else {
    console.log(`Program    ${prog}: link ${r.link?.state ?? 'not claimed by the manifest'}`);
    printApp(r.app);
  }
});

// ---------------------------------------------------------------------------
// oar claim: register an existing app in guarded steps. Nothing is signed until the hosted manifest matches, and
// every transaction is summarized in plain sentences first.
// ---------------------------------------------------------------------------

interface ClaimState {
  cluster: Cluster;
  creator: string;
  nonce: string;
  app_id: string;
  authority: string;
  manifest_uri: string;
}

const claimPaths = (dir: string) => ({
  state: join(dir, 'claim.json'),
  manifest: join(dir, 'site/.well-known/oar-manifest.json'),
  wellKnown: join(dir, 'site/.well-known/oar.json'),
  repoProof: join(dir, 'repo/oar.json'),
});

function loadClaim(dir: string): { state: ClaimState; manifest: OarManifest } {
  const p = claimPaths(dir);
  if (!existsSync(p.state)) throw new Error(`No claim in ${dir}. Run \`oar claim prepare\` first.`);
  const state = readJson(p.state) as ClaimState;
  return { state, manifest: loadValidManifest(p.manifest, { appId: state.app_id, cluster: state.cluster }) };
}

const dirOpt = () => new Option('-d, --dir <dir>', 'claim directory').default('oar-claim');
const collect = (value: string, previous: string[]) => [...previous, value];

/** Print a summary; sign only when the operator passed --yes after reading it. */
function confirmed(lines: string[], yes: boolean): boolean {
  lines.forEach(l => console.log(l));
  if (!yes) {
    console.log('\nNothing was signed. Re-run with --yes to sign this.');
    process.exitCode = 1;
  }
  return yes;
}

const claim = program.command('claim').description('register an existing app: prepare, check, register, link-program');

claim
  .command('prepare')
  .description('derive the App ID and write the manifest and proof files to deploy')
  .requiredOption('--creator <pubkey>', 'wallet that will sign `oar claim register` and pay about 0.0039 SOL rent')
  .requiredOption('--name <name>', 'app name, 1 to 64 characters')
  .option('--domain <host>', 'domain the app is served from (repeatable)', collect, [])
  .option('--program <address>', 'program the app uses (repeatable)', collect, [])
  .option('--repo <url>', 'source repository URL (repeatable)', collect, [])
  .option('--category <category>', 'category (repeatable, 1 to 3; default other)', collect, [])
  .option('--summary <text>', 'one sentence, up to 140 characters')
  .option('--authority <pubkey>', 'record authority (default: the creator; a Squads vault is recommended for production)')
  .option('--manifest-uri <uri>', 'where the manifest will be served (default: https://<first domain>/.well-known/oar-manifest.json)')
  .option('--nonce <n>', 'nonce (default: the first unused one for this creator)')
  .addOption(dirOpt())
  .addOption(clusterOpt())
  .addOption(rpcOpt())
  .option('--force', 'overwrite files from an earlier prepare')
  .action(async o => {
    const cluster = parseCluster(o.cluster);
    const creator = address(o.creator);
    const { nonce, appId } =
      o.nonce !== undefined
        ? { nonce: BigInt(o.nonce), appId: await findAppId({ creator, nonce: BigInt(o.nonce) }) }
        : await nextAppNonce(rpcFor(cluster, o.rpc), creator);
    const domains = (o.domain as string[]).map(d => d.toLowerCase());
    if (!domains.length && !o.manifestUri) throw new Error('Pass --domain, or --manifest-uri for where the manifest will be served.');
    const files = buildClaimFiles({
      appId, cluster, name: o.name, summary: o.summary, categories: o.category as Category[], domains,
      programs: (o.program as string[]).map(a => address(a)), repositories: o.repo, manifestUri: o.manifestUri,
    });
    const manifestUri = files.manifestUri;
    const v = validateManifest(files.manifest);
    if (!v.valid) throw new Error(`The manifest would be invalid:\n  ${v.errors.join('\n  ')}`);

    const p = claimPaths(o.dir);
    writeJson(p.manifest, files.manifest, o.force);
    writeJson(p.wellKnown, files.wellKnown, o.force);
    if (files.repoProof) writeJson(p.repoProof, files.repoProof, o.force);
    const state: ClaimState = { cluster, creator, nonce: nonce.toString(), app_id: appId, authority: o.authority ?? creator, manifest_uri: manifestUri };
    writeJson(p.state, state, o.force);

    console.log(`App ID  ${appId}  (${cluster}, creator ${creator}, nonce ${nonce})\n`);
    let step = 1;
    const onSite = domains.length > 0 && manifestUri.startsWith(`https://${domains[0]}/`);
    if (domains.length) {
      console.log(`${step++}. Deploy ${dirname(p.manifest)}/ to the site root of ${domains.map(d => `https://${d}`).join(', ')}, served with no redirects:`);
      domains.forEach(d => console.log(`     https://${d}/.well-known/oar.json`));
      if (onSite) console.log(`     ${manifestUri}`);
    }
    if (!onSite) console.log(`${step++}. Upload ${p.manifest} so that ${manifestUri} serves it.`);
    if (o.repo.length) console.log(`${step++}. Commit ${p.repoProof} to the root of ${(o.repo as string[]).join(', ')} on the default branch.`);
    console.log(`${step++}. oar claim check --dir ${o.dir}        (confirms the files before anything is signed)`);
    console.log(`${step++}. oar claim register --dir ${o.dir} -k <creator keypair>`);
    if (o.program.length) console.log(`${step++}. oar claim link-program <program> --dir ${o.dir} -k <upgrade authority keypair>   (or --squads <vault>)`);
  });

claim
  .command('check')
  .description('check the hosted manifest and every proof; signs nothing')
  .addOption(dirOpt())
  .addOption(rpcOpt())
  .action(async o => {
    const { state, manifest } = loadClaim(o.dir);
    const appId = address(state.app_id);
    const rpc = rpcFor(state.cluster, o.rpc);
    const record = await fetchMaybeAppRecord(rpc, appId);
    if (record.exists) {
      const same = bytesEqual(record.data.manifestHash, hashManifest(manifest));
      console.log(`${same ? '✓' : '·'} record     ${appId} is registered${same ? ' with this manifest' : ', pointing at a different manifest (use `oar update`)'}`);
    } else {
      console.log(`· record     ${appId} is not registered yet`);
    }
    const hosting = await checkManifestHosting(state.manifest_uri, manifest);
    console.log(hosting.ok ? `✓ manifest   ${state.manifest_uri} serves this manifest` : `✗ manifest   ${hosting.detail}`);
    for (const host of manifest.domains ?? []) {
      const r = await checkDomain(host, appId, state.cluster);
      console.log(`${mark[r.state]} domain     ${host}: ${r.state}${r.method ? ` via ${r.method}` : ''}${r.detail ? ` (${r.detail})` : ''}`);
    }
    for (const repo of manifest.repositories ?? []) {
      const r = await checkRepository(repo.url, appId, state.cluster);
      console.log(`${mark[r.state]} repository ${repo.url}: ${r.state}${r.detail ? ` (${r.detail})` : ''}`);
    }
    for (const p of manifest.programs ?? []) {
      const progRpc = p.cluster === state.cluster ? rpc : rpcFor(p.cluster);
      const prog = address(p.address);
      const link = backlinkMatches(await fetchProgramBacklink(progRpc, prog), appId, state.cluster);
      let signer = '';
      if (link.state !== 'verified') {
        const owner = await getProgramUpgradeAuthority(progRpc, prog).catch(() => null);
        signer = !owner ? ' (not a deployed program)'
          : owner.authority ? ` (sign with upgrade authority ${owner.authority}: oar claim link-program ${prog})`
          : ' (frozen or not upgradeable: needs an issuer attestation)';
      }
      console.log(`${mark[link.state]} program    ${prog}: ${link.state}${link.detail && link.state !== 'verified' ? ` (${link.detail})` : ''}${signer}`);
    }
    if (!hosting.ok) {
      console.error('\nNot ready: `oar claim register` refuses until the manifest above is served.');
      process.exitCode = 1;
    }
  });

claim
  .command('register')
  .description('create the App ID onchain, signed by the creator')
  .addOption(dirOpt())
  .addOption(rpcOpt())
  .addOption(keypairOpt())
  .option('--yes', 'sign after reading the summary')
  .action(async o => {
    const { state, manifest } = loadClaim(o.dir);
    const signer = await loadKeypair(o.keypair);
    if (signer.address !== state.creator) {
      throw new Error(`This App ID derives from creator ${state.creator}; the keypair is ${signer.address}. Prepare again with --creator ${signer.address}.`);
    }
    const rpc = rpcFor(state.cluster, o.rpc);
    const appId = address(state.app_id);
    if ((await fetchMaybeAppRecord(rpc, appId)).exists) throw new Error(`${appId} is already registered. Use \`oar update\` to change its manifest.`);
    const hosting = await checkManifestHosting(state.manifest_uri, manifest);
    if (!hosting.ok) throw new Error(`Not registering: ${hosting.detail}`);
    const nonce = BigInt(state.nonce);
    const authority = address(state.authority);
    const summary = describeRegistration({
      appId, cluster: state.cluster, creator: signer.address, nonce, authority, manifestUri: state.manifest_uri, manifestSha256: hosting.sha256,
    });
    if (!confirmed(summary, o.yes)) return;
    const ix = await getRegisterInstructionAsync({ creator: signer, nonce, authority, manifestUri: state.manifest_uri, manifestHash: hashManifest(manifest) });
    assertRegistrationInstructions([ix]);
    console.log(`\nRegistered ${appId}\nSignature ${await sendAndConfirm(rpc, signer, [ix])}`);
  });

claim
  .command('link-program <program>')
  .description("point a program back to this App ID, signed by the program's upgrade authority")
  .addOption(dirOpt())
  .addOption(new Option('-u, --rpc <url>', "RPC URL for the program's cluster"))
  .addOption(keypairOpt())
  .option('--squads <vault>', 'build an unsigned transaction for a Squads vault to approve, instead of signing')
  .addOption(new Option('--encoding <encoding>', 'encoding for --squads').choices(['base58', 'base64']).default('base58'))
  .option('--legacy', 'export a legacy transaction (Squads v3 accepts only legacy)')
  .option('--yes', 'sign after reading the summary')
  .action(async (prog: string, o) => {
    const { state, manifest } = loadClaim(o.dir);
    const claimed = (manifest.programs ?? []).find(p => p.address === prog);
    if (!claimed) throw new Error(`${prog} is not listed in the manifest, so its backlink would not verify. Add it to the manifest first.`);
    const rpc = rpcFor(claimed.cluster, o.rpc);
    const signer = o.squads ? createNoopSigner(address(o.squads)) : await loadKeypair(o.keypair);
    const plan = await getProgramLinkInstructions(rpc, {
      program: address(prog), appId: address(state.app_id), cluster: state.cluster, authority: signer, payer: signer,
    });
    const summary = describeProgramLink(plan, signer.address);
    if (plan.action === 'unchanged') return summary.forEach(l => console.log(l));
    assertRegistrationInstructions(plan.instructions);
    if (o.squads) {
      summary.forEach(l => console.log(l));
      const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const tx = exportUnsignedTransaction(plan.instructions, signer.address, value, { version: o.legacy ? 'legacy' : 0 });
      console.log(`\nImport this ${o.encoding} transaction into Squads as a proposal for vault ${o.squads}. The vault pays the rent, so it needs SOL.\n`);
      console.log(tx[o.encoding as 'base58' | 'base64']);
      return;
    }
    if (!confirmed(summary, o.yes)) return;
    console.log(`\nLinked ${prog} to ${state.app_id}\nSignature ${await sendAndConfirm(rpc, signer as KeyPairSigner, plan.instructions)}`);
  });

program.parseAsync().catch(e => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
