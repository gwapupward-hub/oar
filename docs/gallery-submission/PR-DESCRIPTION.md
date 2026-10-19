# Draft upstream PR: solana-foundation/templates

**Title:** Add OAR App Identity Starter community template

**Branch:** `community/oar-identity-starter` on a fork of `solana-foundation/templates`, created from upstream
`d7961ba` with `0001-add-oar-identity-starter.patch` (sha256
`997f6c438df5218f0d526b8aa6ce7e8d26585025a3983c93ee461052e32fa413`).

> Do not open this PR until the blockers in `docs/GALLERY-READINESS.md` are cleared (SDK on the npm registry,
> SDK rc.3 released). Replace the "Evidence" numbers below with the final run.

---

## What this adds

`community/oar-identity-starter`: a Next.js (Solana Kit) starter for apps that want a public, independently
verifiable identity. It prepares an **Open App Registry (OAR)** App ID, a manifest, and reciprocal domain and
repository proofs from a **public** creator address, offline.

## The problem

Wallets and explorers see program addresses, not apps. Nothing tells a user that program `X`, the site they are
on, and the repository they are reading belong to the same team, so look-alike sites and repurposed programs are
hard to spot. OAR gives each app one App ID whose manifest **claims** its programs, domains and repositories; each
claim only counts when the other side agrees (domain `/.well-known/oar.json` or `_oar` TXT, root `oar.json` in the
repo, and a canonical Program Metadata backlink written by the program's upgrade authority).

## How it complements existing tooling

- Uses Solana Kit and the existing [Program Metadata](https://github.com/solana-program/program-metadata) program
  for program backlinks; no new wallet adapter, no custom signing.
- Works next to Anchor: `npm run oar:anchor` imports public `[programs.devnet]` IDs from an existing `Anchor.toml`.
- Optional SAS (Solana Attestation Service) attestations are supported by the SDK, with **no issuer trusted by
  default**.

## Why it belongs in the community gallery

It is a first-session starter: `create-solana-dapp` → `npm run dev` works with no wallet, RPC key or OAR knowledge.
Identity is an explicit later step with clear states, so developers learn the difference between registering and
being verified from the first page.

## Architecture (permissionless)

- App ID = PDA(creator, nonce) of the OAR registry program; the record stores the manifest URI and its RFC 8785
  SHA-256.
- Anyone can register; nobody can make a domain, repository or program point back without controlling it.
- States shown to users: Linked (reciprocal evidence), Attested (trusted issuer you chose), Unverified, Temporarily
  unavailable (RPC/HTTP/DNS outage, retry), Disputed / invalid (evidence contradicts the claim).

## Frameworks

Next.js 16 (App Router), React 19, TypeScript 5.9, `@solana/kit` 8.4. Works with npm, pnpm and yarn (pnpm's
forwarded `--` is handled).

## Devnet and limitations

- The registry is on **Devnet only**. Mainnet is NO-GO until an independent security review and multisig upgrade
  governance are complete.
- OAR is a community project, not a Solana Foundation standard or endorsement.
- Domain proofs must be served without redirects; repository proofs are read from GitHub or GitLab default branches.

## Security boundaries

- No private keys, keypair files or seed phrases are read or generated; `.gitignore` excludes `*-keypair.json` and
  `id.json`.
- No script sends a transaction or signs. Registration and program linking need the user's own wallet approval
  (https://oarprotocol.xyz/register, or the OAR CLI with the user's local signer).
- `.env.example` holds only a public Devnet RPC default; production requires a server-side `OAR_DEVNET_RPC_URL`.
- Manifest URIs that follow a branch/`HEAD`, or that reuse the proof file name `oar.json`, are refused.

## Checks run on this branch

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` (pnpm 10.5.2 lockfile check) | up to date; lockfile diff adds only this importer (+128 lines, 0 removed) |
| `pnpm generate` | `templates.json`, `TEMPLATES.md`, `.github/workflows/templates.json` updated with this entry only |
| `pnpm lint` | All templates are valid; Prettier clean; `tsc --noEmit` clean |
| `pnpm validate` | Validation passed |
| `pnpm security:check` | for this template: 1 finding, `dependency-remote-source` — see Blockers |
| `pnpm health --only community/oar-identity-starter --boot` | build ✅, boot ✅; warn: newer majors of `@types/node` and `typescript` exist |
| `og-image.png` | 1200×630 PNG, 13,679 bytes, generated with `pnpm create-image "OAR App Identity"` |

Independent starter tests (OAR repository, `create-solana-dapp@4.8.5`): generation and rename, install with no
monorepo paths, typecheck, production build, `next start` serving `/`, identity preparation from a public address,
schema-valid proofs, refusal of unconfigured/invalid input, and independence of two generated projects, on Node
22.22.0 and 24.22.0; automated in OAR's `external-template-smoke` workflow.

## Blockers to clear before opening

- `@open-app-registry/sdk` is installed from a GitHub release tarball. Publishing it to the npm registry removes the
  `dependency-remote-source` finding.
