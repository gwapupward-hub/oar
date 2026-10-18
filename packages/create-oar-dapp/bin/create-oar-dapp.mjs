#!/usr/bin/env node
// OAR App Standard starter generator. No network access, signing, or private key handling.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const usage = `Usage: create-oar-dapp <project-slug> [options]

Options:
  --name <name>        Display name (default: humanized project slug)
  --domain <hostname>  Public hostname, if already owned (optional)
  --repo <url>         GitHub repository HTTPS URL (optional)
  --category <value>   One OAR category (default: other)
  --template nextjs    Starter type (only nextjs is supported)
  --help               Show this help

Generates a local Next.js starter and oar.config.json. It never signs
transactions or reads private keys. Run npm install in the new directory.
`;
const categories = new Set(['defi', 'dex', 'lending', 'payments', 'wallet', 'nft', 'marketplace',
  'gaming', 'social', 'identity', 'infrastructure', 'developer-tools', 'dao',
  'ai-agent', 'data', 'depin', 'media', 'other']);
const fail = message => { throw new Error(message); };
function parse(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let slug;
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (!['--name', '--domain', '--repo', '--category', '--template'].includes(arg)) fail('Unknown option: ' + arg);
      if (arg.slice(2) in options) fail('Repeated option: ' + arg);
      const value = argv[++i];
      if (!value || value.startsWith('--')) fail('Missing value for ' + arg);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith('-')) {
      fail('Unknown option: ' + arg);
    } else if (!slug) {
      slug = arg;
    } else {
      fail('Unexpected positional argument: ' + arg);
    }
  }
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug) || slug.includes('--'))
    fail('Project slug must be 1-64 lowercase letters, digits and single hyphens; no paths.');
  if (options.template && options.template !== 'nextjs') fail('Only the nextjs template is available.');
  const name = options.name ?? slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  if (!name.trim() || name.length > 64 || /[\x00-\x1f\x7f]/.test(name))
    fail('App name must be 1-64 printable characters.');
  const domain = (options.domain ?? '').toLowerCase();
  if (domain && (domain.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) ||
    domain.split('.').some(label => label.length > 63 || label.startsWith('-') || label.endsWith('-'))))
    fail('Domain must be a DNS hostname, without https:// or a path.');
  const repo = options.repo ?? '';
  if (repo && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(repo))
    fail('Repository must be https://github.com/owner/repo.');
  const category = options.category ?? 'other';
  if (!categories.has(category)) fail('Unknown OAR category: ' + category);
  return { slug, name, domain, repo: repo.replace(/\/$/, ''), category };
}
function generate(config, cwd = process.cwd()) {
  const target = resolve(cwd, config.slug);
  if (existsSync(target)) fail('Refusing to overwrite existing path: ' + target);
  const template = resolve(dirname(fileURLToPath(import.meta.url)), '../templates/nextjs');
  mkdirSync(target);
  cpSync(template, target, { recursive: true, errorOnExist: true, force: false });
  const packagePath = join(target, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.name = config.slug;
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  const data = { standard: '0.1', cluster: 'solana:devnet', name: config.name,
    summary: '', category: config.category, domain: config.domain,
    repositories: config.repo ? [config.repo] : [], programs: [], nonce: 0 };
  writeFileSync(join(target, 'oar.config.json'), JSON.stringify(data, null, 2) + '\n');
  console.log('Created ' + config.slug + ' with OAR App Standard v0.1');
  console.log('Next: cd ' + config.slug + ' && npm install && npm run dev');
  console.log('When ready: npm run oar:prepare -- --creator <PUBLIC_WALLET_ADDRESS>');
}
try {
  const config = parse(args);
  if (config.help) process.stdout.write(usage);
  else generate(config);
} catch (e) {
  console.error('create-oar-dapp: ' + e.message);
  process.exitCode = 1;
}
