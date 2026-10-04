#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command, Option } from 'commander';
import { address, type Address } from '@solana/kit';
import {
  AppStatus,
  buildProgramLink,
  buildProofFile,
  checkDomain,
  fetchMaybeAppRecord,
  findAppId,
  getAcceptAuthorityInstruction,
  getProposeAuthorityInstruction,
  getRegisterInstructionAsync,
  getSetStatusInstruction,
  getUpdateManifestInstruction,
  hashManifest,
  hashManifestHex,
  parseJsonStrict,
  resolveApp,
  resolveProgram,
  validateManifest,
  type Cluster,
  type OarManifest,
  type ResolvedApp,
} from '@open-app-registry/sdk';
import { loadKeypair, parseCluster, rpcFor, sendAndConfirm } from './tx.js';

const program = new Command()
  .name('oar')
  .description('Open App Registry: onchain application identity for Solana')
  .version('0.1.1-rc.1');

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

program.parseAsync().catch(e => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
