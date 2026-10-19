# Solana Community Template Gallery readiness

Status as of 2026-10-19. Base reviewed: `main` at `4aba99b`. OAR is Devnet only; **mainnet is NO-GO**. Nothing in this
report is a Solana Foundation listing or endorsement: OAR is listed only once upstream maintainers merge the
contribution and https://solana.com/developers/templates shows it.

**Submission complete: NO.** The OAR starter and the upstream community template now depend on the npm-published SDK
`@open-app-registry/sdk@0.1.1-rc.3` instead of a GitHub release tarball. Both pass the checks below locally, but the
community template has not been submitted to `solana-foundation/templates`. The blockers are below.

## Gates

| Gate | Status | Evidence | Commit | Next action |
| --- | --- | --- | --- | --- |
| A. RPC outages never become failed proofs (#20) | PASS, merged (`fd8df61`) | [#20](https://github.com/gwapupward-hub/oar/pull/20): CI 7/7 green; SDK 59/59, CLI 8/8 | `deed540` | Done |
| B. Manifest URI policy, reserved proof path, retryable state (#21) | PASS, merged (`c4d3f77`) | [#21](https://github.com/gwapupward-hub/oar/pull/21): CI 7/7 green; SDK 64/64, CLI 9/9, starter 10/10 | `40d6e5c` | Done |
| B. Explorer shows outages as "Temporarily unavailable" (oar-web#13) | PASS, merged; inert until SDK bump | [oar-web#13](https://github.com/gwapupward-hub/oar-web/pull/13): CI green; 35/35 tests; build | `b5d1b8d` | Bump oar-web's SDK to `0.1.1-rc.3` (it still pins rc.2) |
| B. SDK release candidate v0.1.1-rc.3 (#22) | PASS: merged (`88af035`), tagged, published to npm | GitHub pre-release `v0.1.1-rc.3` (2026-10-19 07:49Z); npm `0.1.1-rc.3` (2026-10-19 09:52Z, `next` dist-tag); npm tarball byte-identical to the release asset | `1a08b4d` | Done |
| C. Standalone template acceptance (#23) | PASS, merged (`6b69e01`) | [#23](https://github.com/gwapupward-hub/oar/pull/23): CI 7/7 green incl. extended external-template job; acceptance table below | `3d30a63` | Done |
| D. Community template package | PASS locally on rc.3 from npm; patch regenerated; not submitted | `docs/gallery-submission/` (patch, PR draft); upstream checks below | upstream `6567909` on `d7961ba` | Owner: fork, `git am` the patch, review the lockfile notes below, then open the PR |
| D. Upstream `security:check` | `dependency-remote-source` eliminated for this template (0 starter findings) | Upstream report, this run | — | None for this PR. Upstream may refresh its acknowledgement list (see risks) |
| E. Devnet end-to-end (signed steps) | BLOCKED (owner signature) | `release/evidence/gallery-e2e-2026-10-19-Bu1JCyxi.json` | `522859e` | Record authority signs the prepared manifest update |
| E. Upstream PR | BLOCKED (fork + owner review) | This session cannot fork `solana-foundation/templates` | — | Owner: fork, push the patch, open the PR |

## Source and versions

- OAR source reviewed: `main` `4aba99b`; stacked work in #20 → #21 → #22 / #23, and the branch for issue #26.
- Program: unchanged since the devnet build (no diff under `programs/`, `Cargo.toml`, `Cargo.lock` since
  `v0.1.1-rc.2`). Tests ran against the released binary, sha256
  `e6112ffffdffb12817006ffe57856ad96d00f3ce84adb769baf126ddaaf37a5a` (matches the rc.2 `SHA256SUMS`).
- SDK: `@open-app-registry/sdk@0.1.1-rc.3` is on npm (`next` dist-tag; `latest` is `0.0.0-stage`). Registry integrity
  `sha512-Pa1QW2xW…8HQ==`. The npm tarball is byte-identical to the GitHub release asset
  `open-app-registry-sdk-0.1.1-rc.3.tgz` (sha256 `9a13cd3f…6b42`, which matches `SHA256SUMS` on the release).
- OAR starter (`packages/create-oar-dapp/templates/nextjs`) and the upstream community template pin the exact version
  `0.1.1-rc.3` from npm. They previously pinned the rc.2 GitHub release tarball.
- oar-web still pins rc.2 (gate B above).
- Starter requirements: Node ≥ 22 for the community template, Node ≥ 24 for the OAR template (`engines`). In this
  session the OAR template was typechecked and built on Node 22.22.0 and 24.22.0. The community template was checked
  through the upstream health run (Node 22 in this sandbox).

## Fixed in this round

| Defect | Fix | Verified by |
| --- | --- | --- |
| Trusted-attestation RPC failure reported as `invalid` | `fetchClaimAttestation` → `unavailable`; claim stays `unverified` + retry | SDK test fails on old source, passes on new |
| CLI `inspect` on RPC outage: generic error | exit 2, JSON `{status:'unavailable'}` | CLI test against an HTTP 503 RPC |
| `devnet/oar-app.mjs` would sign a backlink write after a failed read | refuses; retries unavailable resolution | code review, `node --check` |
| Manifest URIs on branches/`HEAD` accepted | `checkManifestUri` in SDK, CLI `register`/`update`/`claim`, starter | SDK, CLI and starter tests (positive and negative) |
| `oar.json` usable as manifest location | reserved name, refused everywhere | same |
| Outage indistinguishable from "no proof" for consumers | `retryable: true` on `unverified` claims | SDK tests; CLI and oar-web display tests |
| Starter threw on RPC outage | `getProgramIdentity` → `verified \| unverified \| unavailable` | typechecks against rc.3 (this run) |
| `create-solana-dapp` printed `+npm run dev` | commands on their own lines | test pins the `+`-at-start rule |
| pnpm users: `oar:prepare -- --creator` failed | scripts accept pnpm's forwarded `--` | tests; real `pnpm run` |
| Scanner false positive on `regex.exec(line)` | `line.match(regex)` | `pnpm security:check` |
| Starter and gallery patch installed from a GitHub release tarball (HTTP 401 under pnpm 10.5.2; `dependency-remote-source`) | Exact pin `0.1.1-rc.3` from npm in the OAR template and the upstream package; patch regenerated; lockfile regenerated with pnpm 10.5.2 | fresh npm install; upstream frozen install under pnpm 10.5.2 (no 401); upstream `security:check` |

## Starter tests on rc.3 (this run)

| Check | Result |
| --- | --- |
| Fresh `npm install` of the OAR template from the public registry (no GitHub tarball) | PASS: SDK `0.1.1-rc.3` resolved, 92 packages, 0 vulnerabilities, no 401 |
| `npm run typecheck` and production `npm run build` (Node 22.22.0) | PASS |
| `npm run typecheck` and production `npm run build` (Node 24.22.0) | PASS |
| `npm run oar:prepare -- --creator 91N96ZPG…` with a placeholder domain (scratch copy only) | PASS: App ID `Bu1JCyxi…`, the same App ID as the registered devnet app for this creator and nonce 0. Manifest and `oar.json` written |
| `npm run oar:prepare` with no domain or manifest URI | Refused (intended guard) |
| `oar:prepare` with a non-public creator (`not-a-key`) | Refused (intended guard) |
| `next start`: `/` 200 with "not registered" and "not a security audit"; unknown route 404; prepared manifest served 200 | PASS |
| `node --test packages/create-oar-dapp/test/*.test.mjs` | PASS 10/10 |
| `create-solana-dapp@4.8.5` end-to-end (`gh:` download and rename) | Not rerun in this session. OAR's `external-template-smoke` job runs it on the PR |

Carried over from the rc.2 run (not repeated on rc.3): `create-solana-dapp` download and rename for `alpha-dapp`,
`beta-dapp`, `gamma-node24`; `oar:prepare` refusals for empty domain, keypair path, mainnet, bad program ID, overwrite and
`HEAD` manifest URI; schema validity of proofs; two projects with no shared state; Anchor adapter behavior; no key or
signing code in generated sources; create-solana-dapp's optional "Solana dev skill" step failed in the sandbox and is not
part of the template.

## Solana upstream validation (templates `d7961ba` + patch `6567909`)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` with pnpm 10.5.2 (upstream CI version) | PASS in 55.7 s; no HTTP 401; no GitHub tarball fetch |
| `pnpm install --lockfile-only` with pnpm 10.5.2 (regeneration) | Exit 0. Churn beyond this importer is described below |
| `pnpm generate` | PASS; no further changes to `templates.json`, `TEMPLATES.md`, `.github/workflows/templates.json` |
| `pnpm lint` | PASS: all templates valid; Prettier and `tsc --noEmit` clean |
| `pnpm validate` | PASS |
| `pnpm security:check` | PASS (advisory). 46 templates and 2960 packages scanned. Starter: 0 findings. Report: 1 new LOW `dependency-build-script-blocked` for `puppeteer@23.11.1` at its `typescript@7.0.2` peer path (see risks), and 1 HIGH `manifest-lifecycle-script` on `x402-solana-rust` (acknowledged; not this template) |
| `pnpm health --only community/oar-identity-starter --boot` | 0 pass · 1 warn · 0 fail. build ✅ boot ✅. Warn: `@types/node` 24.10.4 → 26.6.5 and `typescript` 5.9.3 → 7.0.2 are two majors behind |
| `og-image.png` | Unchanged: 1200×630 PNG, 13,679 bytes |
| Discovery | `templates.json` id `gh:solana-foundation/templates/community/oar-identity-starter`; listable by `create-solana-dapp` only after merge |

### Lockfile churn (for reviewers)

Regenerating `pnpm-lock.yaml` with the npm SDK changes more than this template's importer. Parsed YAML compared with
`d7961ba`:

- Importers: 2 changed. `community/oar-identity-starter` (the new SDK entry). `community/solana-chatgpt-kit` (a
  peer-variant hash only).
- Packages: the rc.2 tarball entry becomes the npm entry. The registry also refreshed the `@paulmillr/qr` deprecation text.
- Snapshots: 15 removed, 28 added, 33 changed. These are peer-context variants of packages already in the lockfile. The
  visible effect is `ws` resolving to 8.21.0 or 8.22.0 in some contexts that used 8.18.3 before (used by
  `@coinbase/cdp-sdk`, `@base-org/account`, `@solana-program/*` and `@solana-commerce/sdk`, among others). Some `@expo/*`
  snapshots also changed their `optional` flag.

Running the same regeneration on the unmodified base lockfile produced no changes, so the churn comes from adding the SDK's
npm dependency graph, not from the pnpm version. Disabling pnpm's peer dedupe made it much worse, so that approach was
discarded. Accepting this churn is a reviewer decision. The other templates were not built in this run; only the upstream
checks above were.

### Release-age guard

Upstream `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, but the pinned pnpm 10.5.2 used by every upstream workflow
showed no warning and did not enforce it. `0.1.1-rc.3` was published at 09:52Z and resolved without any maturity check in
the regeneration. Upstream should either upgrade pnpm to a version that implements the setting, or add an explicit
exclusion for the SDK.

Final template files (`community/oar-identity-starter/`): `.env.example`, `.gitignore`, `README.md`,
`next.config.mjs`, `oar.config.json`, `og-image.png`, `package.json`, `scripts/import-anchor-programs.mjs`,
`scripts/lib/anchor-programs.mjs`, `scripts/lib/manifest-uri.mjs`, `scripts/prepare-oar.mjs`,
`src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/lib/oar.ts`, `tsconfig.json`.

## Devnet evidence

Live, read-only (`npm run devnet:gallery-e2e`, slot 512683656, commit `522859e`):

- App `Bu1JCyxiVDdDGjtNLLkKhq6KZv6E4LcUgqNkS5t5Nf2K` is registered (revision 0, authority
  `91N96ZPGHcFWe2jEZie9rUVqyHF5BWMV7mYnHMurhWB7`); program `oariw8YX…` and repository links verify today.
- **Domain-link problem, root cause:** `https://oarprotocol.xyz/.well-known/oar.json` already names the App ID
  (HTTP 200, no redirect, verifies live), but the onchain record still points at the revision-0 manifest
  (`2b39329…`, sha256 `6ab833dc…`), which lists no domain. The prepared manifest
  (`release/devnet/oar.manifest.json`, commit `05ff278`, on `main`, sha256 `0c4bf3a0…68cb`) lists
  `oarprotocol.xyz`, passes the URI policy, and is served byte-for-byte at its pinned URL.
- Against that manifest, program, domain and repository all verify. The gate stays **BLOCKED** until the record
  authority signs the update. No transaction was sent.
- Offline cross-check on rc.3 (this run): `oar:prepare` for the same creator and nonce 0 derives the same App ID,
  `Bu1JCyxi…`.

### Remaining signed steps (owner only)

1. Record authority `91N96ZPG…` signs a manifest update for `Bu1JCyxi…` to
   `https://raw.githubusercontent.com/gwapupward-hub/oar/05ff278aab30d76bd41cd9505960e8b5f3400d8e/release/devnet/oar.manifest.json`
   (Update card at https://oarprotocol.xyz/register, or `oar update`; see `docs/DOMAIN-VERIFICATION.md`).
2. Re-run `npm run devnet:gallery-e2e -- --creator 91N96ZPGHcFWe2jEZie9rUVqyHF5BWMV7mYnHMurhWB7 --manifest
   release/devnet/oar.manifest.json --manifest-uri <that URI> --write` and add the transaction signature.
3. Optional fresh-project rehearsal: generate a project, configure a domain and repository you control, publish the
   proofs, register with a creator wallet, link a program with its upgrade authority, then run the same script with
   `--creator/--domain/--repo/--program`.

## Approvals required

1. Done: #20, #21, #22, #23 and oar-web#13 are merged.
2. Done: tag `v0.1.1-rc.3` exists on `main` (GitHub pre-release published 2026-10-19 07:49Z).
3. Done: `@open-app-registry/sdk@0.1.1-rc.3` is on npm (2026-10-19 09:52Z). The starter and the community template
   now point at it. oar-web still needs its bump.
4. Sign the Devnet manifest update above (owner).
5. Owner: fork `solana-foundation/templates`, apply the regenerated `docs/gallery-submission/0001-add-oar-identity-starter.patch`
   (upstream commit `6567909`), review the lockfile churn, push branch `community/oar-identity-starter`, and open the
   PR with `docs/gallery-submission/PR-DESCRIPTION.md`.

```bash
gh repo fork solana-foundation/templates --clone && cd templates
git checkout -b community/oar-identity-starter d7961ba
git am /path/to/oar/docs/gallery-submission/0001-add-oar-identity-starter.patch
# already pinned to "@open-app-registry/sdk": "0.1.1-rc.3" from npm; no edit needed
pnpm install --frozen-lockfile && pnpm generate && pnpm lint && pnpm validate && pnpm security:check
git push -u origin community/oar-identity-starter
```

## Unresolved risks

- **Lockfile churn.** The regenerated lockfile changes peer-context and `ws` resolutions for other templates (see above).
  Upstream reviewers must accept it or ask for a narrower resolution. Those templates were not built in this run.
- **Release-age guard inert.** `minimumReleaseAge: 1440` is not enforced by the pinned pnpm 10.5.2 (see above).
- **Upstream acknowledgement drift.** `security:check` reports a LOW `puppeteer@23.11.1` note at a `typescript@7.0.2`
  peer path. The same lockfile entry already exists on `d7961ba`. The stale acknowledgement is keyed to an older
  `typescript@5.9.3` path. It is not introduced by this change, but upstream may need to refresh that entry.
- **oarprotocol.xyz display.** It still shows "Disputed / invalid" during an RPC outage until oar-web takes rc.3. The
  starter's own helper turns the same outage into `unverified`, never a failure badge.
- **Upstream lockfile is the authoritative one.** The OAR template has no lockfile of its own. Only the regenerated
  upstream lockfile is verified by the frozen install.
- The OAR CLI is not on npm; the README points CLI users to the repository.
- Upstream maintainers may ask for a different name, image or scope.

## Out of scope (mainnet gates, unchanged)

Independent program security audit, mainnet program ID, upgrade-authority transfer to Squads, governance timelock,
mainnet deployment, and owner-controlled key operations.
