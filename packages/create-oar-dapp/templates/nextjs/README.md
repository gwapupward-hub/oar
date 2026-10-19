# OAR-ready Solana dApp (Devnet)

Use this standalone template with Solana's `create-solana-dapp` CLI (tested with
`create-solana-dapp@4.8.5`, the npm `latest` tag as of 2026-10-19):

```bash
npm create solana-dapp@latest -t gh:gwapupward-hub/oar/packages/create-oar-dapp/templates/nextjs
```

Alternatively, generate it with OAR's own `create-oar-dapp` script in the source
repository. Both entry paths use **OAR App Standard v0.1**. The Solana CLI renames the npm package but deliberately leaves the OAR manifest identity name as an explicit edit in `oar.config.json`.
This is a minimal Next.js application, not a deployed onchain program or a verified app.

## Local development

```bash
npm install
npm run dev
npm run typecheck
```

Edit `src/app/page.tsx` to build your product.

## Solana Kit and Anchor developer adapters

- `src/lib/oar.ts` is a **server-only** @solana/kit + OAR SDK adapter that
  resolves a program's publisher identity only after the existing OAR verifier
  confirms a canonical program backlink. Import `getProgramIdentity`
  into a server component or server-side handler, never a client component.
  It returns `verified` (both sides agree), `unverified` (no matching proof;
  not a statement that the program is unsafe) or `unavailable` (the RPC read
  failed; show a retry, never a failure).
- Development uses the public Solana Devnet endpoint; **production requires**
  the server-side `OAR_DEVNET_RPC_URL` environment variable pointing at a
  dedicated HTTPS Devnet RPC. Do not prefix a token-bearing RPC URL with `NEXT_PUBLIC_`.
- For projects using an existing Anchor workspace, import the public program IDs
  **after deployment**:

```bash
npm run oar:anchor -- --workspace ../my-anchor-project
npm run oar:anchor -- --workspace ../my-anchor-project --yes
```

The first command is preview-only. The second modifies `oar.config.json`;
existing nonempty program lists require `--yes --replace`. The adapter reads
`[programs.devnet]` from `Anchor.toml`, not program keypair files. Program
addresses are declarations, **not** proof of deployment or ownership. Linking
still requires the actual program upgrade authority's signature.

This adapter does not scaffold or deploy an Anchor Rust program. Use
`anchor init` and `anchor deploy --provider.cluster devnet` in your own
program workspace before linking it.

## Prepare your OAR identity

1. Edit `oar.config.json` to set your real app name, domain, source repository,
   optional deployed program addresses, and category. The direct template starts with
   `domain: ""`, so identity preparation intentionally fails until you configure
   a real domain or a supported hosted `manifestUri`. Do not list domains or programs
   you do not control. Domain may be empty during early local development.
2. Choose the **public** Solana creator wallet address. Use a wallet you control;
   it determines your permanent OAR App ID. Never paste or store its seed/private key.
3. After choosing a public domain or a custom `manifestUri` in the config, run:

```bash
npm run oar:prepare -- --creator YOUR_PUBLIC_SOLANA_ADDRESS
```

The command derives an App ID for creator+nonce (default nonce 0), uses the installed
OAR SDK to produce a strictly valid, RFC 8785-hashed manifest and reciprocal proofs:

- `public/.well-known/oar-manifest.json`: hosted manifest, committed by hash onchain
- `public/.well-known/oar.json`: domain proof (when `domain` is configured)
- `oar.json`: GitHub root repository proof (when a repository is configured)

A custom `manifestUri` must be immutable or pinned: `ar://`, `ipfs://`, or a raw
GitHub/GitLab URL naming a full 40-character commit SHA. Branch, tag and `HEAD`
references (`.../main/...`, `.../refs/heads/...`, `.../HEAD/...`) are refused,
because the onchain hash would stop matching the next time the branch moves. The
file name `oar.json` is reserved for the domain and repository proofs, so the
manifest can never be hosted at a proof path.

These files are NOT verification by themselves. A creator may have already used nonce
0; check chain state before signing and pass `--nonce 1` or edit the config if needed.
The command refuses to overwrite existing proofs; inspect files before `--force`.

## Register on Devnet

1. Deploy the site and confirm `/.well-known/oar-manifest.json` and
   `/.well-known/oar.json` (if applicable) return HTTP 200 without redirects.
2. Commit the generated root `oar.json` to the default branch of every repository
   listed in the manifest. For multiple repositories, install the proof in each.
3. At https://oarprotocol.xyz/register, connect the same **creator wallet**, use the
   existing registration workflow and verify the hosted manifest/hash before signing.
   Only the wallet owner signs. No keys are given to OAR or the generated app.
4. If a program is declared, its actual program upgrade authority must sign the
   canonical Program Metadata `oar` backlink separately, or approve a Squads proposal.
5. Inspect the App ID and each claim's actual status. Registration is not an audit,
   endorsement or guarantee of safety.

The OAR CLI also supports Devnet registration for developers with their own secured
local signer setup; see https://github.com/gwapupward-hub/oar/blob/main/docs/REGISTERING.md.

## Boundaries

OAR is optional and permissionless. This starter generates no program ID keypairs,
makes no token transfers, submits no transactions, and never signs silently.
Do not call your app "verified" based only on generated files or a wallet address.
The registry remains **Mainnet NO-GO** until its independent release gates pass.
