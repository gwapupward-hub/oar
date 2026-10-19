# Draft upstream PR: solana-foundation/templates

**Title:** Add OAR App Identity Starter community template

**Branch:** `community/oar-identity-starter` on a fork of `solana-foundation/templates`, created from upstream
`d7961ba` with `0001-add-oar-identity-starter.patch` (upstream commit `6567909`, sha256
`e35ebc5b98dbf3df1c3f3a178eabf65c76d1cef7898a2e08d4dec1ae2e002d5a`).

> Open this PR only after the owner has reviewed the OAR PR that regenerates this patch (issue #26) and accepted the
> lockfile notes under "Notes for reviewers". The SDK blocker is cleared: `@open-app-registry/sdk@0.1.1-rc.3` is on npm.

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
- The SDK is pinned to an exact published version (`0.1.1-rc.3`) from the npm registry, not from a URL.

## Checks run on this branch

Run on upstream `d7961ba` with the patch applied, using the upstream pinned pnpm `10.5.2`.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS in 55.7 s; no HTTP 401; no GitHub tarball fetch |
| `pnpm install --lockfile-only` (regeneration) | Exit 0. Changes beyond this importer: see "Notes for reviewers" |
| `pnpm generate` | PASS; `templates.json`, `TEMPLATES.md` and `.github/workflows/templates.json` already match this entry |
| `pnpm lint` | PASS: all templates valid; Prettier clean; `tsc --noEmit` clean |
| `pnpm validate` | PASS |
| `pnpm security:check` | PASS (advisory). This template: 0 findings. `dependency-remote-source` no longer reported. Report also lists 1 LOW `puppeteer` note (see "Notes for reviewers") |
| `pnpm health --only community/oar-identity-starter --boot` | 0 pass · 1 warn · 0 fail. Build ✅, boot ✅. Warn: `@types/node` and `typescript` two majors behind |
| `og-image.png` | 1200×630 PNG, 13,679 bytes, generated with `pnpm create-image "OAR App Identity"` |

Independent starter tests (OAR repository, against the npm-published `0.1.1-rc.3`): fresh install from the public registry,
typecheck and production build on Node 22.22.0 and 24.22.0, identity preparation from a public address (App ID matches the
registered devnet app for that creator and nonce 0), refusal of unconfigured or invalid input, `next start` serving `/`,
the prepared manifest, and unknown routes returning 404. The `create-solana-dapp@4.8.5` download-and-rename run is covered by
OAR's `external-template-smoke` workflow on the OAR PR.

## Notes for reviewers

- **Lockfile churn.** Adding the SDK's npm dependency graph re-resolves peer contexts for other templates. Compared with
  `d7961ba`: 2 importers changed (this one, and `community/solana-chatgpt-kit`, a peer-variant hash only); 15 snapshots
  removed, 28 added and 33 changed. Most visible effect: `ws` resolves to 8.21.0 or 8.22.0 in some contexts that used
  8.18.3 (for example `@coinbase/cdp-sdk`, `@base-org/account`, `@solana-program/*`, `@solana-commerce/sdk`). Some `@expo/*`
  snapshots also change their `optional` flag. The unmodified base lockfile regenerates with no changes under the same
  pnpm, so the churn comes from the new dependency, not the pnpm version. Other templates were not built for this PR.
- **Release-age guard.** `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`. The pinned pnpm 10.5.2 showed no warning
  and did not enforce it: the rc.3 release, published about ten hours earlier, resolved without any maturity check.
  Consider upgrading pnpm or excluding `@open-app-registry/sdk` explicitly.
- **Puppeteer note.** `pnpm security:check` reports a new LOW `dependency-build-script-blocked` for `puppeteer@23.11.1` at
  its `typescript@7.0.2` peer path. The same lockfile entry already exists on `d7961ba`. The acknowledgement list is keyed
  to an older `typescript@5.9.3` path. This PR does not change that.
- **Pinned SDK.** `@open-app-registry/sdk@0.1.1-rc.3` is the npm tarball, byte-identical to the GitHub release asset
  (sha256 `9a13cd3f…6b42`).

## Security posture of the dependency

Before this change, the SDK was installed from a GitHub release tarball (`dependency-remote-source`, HIGH advisory, and a
401 under pnpm 10.5.2). The exact npm pin removes both.
