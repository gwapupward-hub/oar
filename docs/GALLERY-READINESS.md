# Solana Community Template Gallery readiness

Status as of 2026-10-19. Base reviewed: `main` at `7f9a0f6` (merge of #19). OAR is Devnet only; **mainnet is
NO-GO**. Nothing in this report is a Solana Foundation listing or endorsement: OAR is listed only once upstream
maintainers merge the contribution and https://solana.com/developers/templates shows it.

**Submission complete: NO.** The template is built and passes upstream lint/validate/generate locally, but it is not
submitted. The blockers are below.

## Gates

| Gate | Status | Evidence | Commit | Next action |
| --- | --- | --- | --- | --- |
| A. RPC outages never become failed proofs (#20) | PASS, merged (`fd8df61`) | [#20](https://github.com/gwapupward-hub/oar/pull/20): CI 7/7 green; SDK 59/59, CLI 8/8 | `deed540` | Done |
| B. Manifest URI policy, reserved proof path, retryable state (#21) | PASS, merged (`c4d3f77`) | [#21](https://github.com/gwapupward-hub/oar/pull/21): CI 7/7 green; SDK 64/64, CLI 9/9, starter 10/10 | `40d6e5c` | Done |
| B. Explorer shows outages as "Temporarily unavailable" (oar-web#13) | PASS, inert until SDK bump | [oar-web#13](https://github.com/gwapupward-hub/oar-web/pull/13): CI green; 35/35 tests; build | `b5d1b8d` | Merge; bump SDK after rc.3 |
| B. SDK release candidate v0.1.1-rc.3 (#22) | Merged (`88af035`); BLOCKED on tag | [#22](https://github.com/gwapupward-hub/oar/pull/22): CI green; `release.mjs check` OK; local packs identical | `1a08b4d` | Owner: tag `v0.1.1-rc.3` on `main` |
| C. Standalone template acceptance (#23) | PASS, merged (`6b69e01`) | [#23](https://github.com/gwapupward-hub/oar/pull/23): CI 7/7 green incl. extended external-template job; acceptance table below | `3d30a63` | Done |
| D. Community template package | PASS locally; not submitted | `docs/gallery-submission/` (patch, PR draft); upstream checks below | templates `cdb4d8c` on upstream `d7961ba` | Clear the npm blocker, then fork and open the PR |
| D. Upstream `security:check` | 1 HIGH advisory finding on this template | `dependency-remote-source`: SDK installed from a GitHub release tarball | — | Owner: approve npm publication of `@open-app-registry/sdk` |
| E. Devnet end-to-end (signed steps) | BLOCKED (owner signature) | `release/evidence/gallery-e2e-2026-10-19-Bu1JCyxi.json` | `522859e` | Record authority signs the prepared manifest update |
| E. Upstream PR | BLOCKED (fork + blockers) | This session cannot fork `solana-foundation/templates` | — | Owner: fork, push the patch, open the PR |

## Source and versions

- OAR source reviewed: `main` `7f9a0f6`; stacked work in #20 → #21 → #22 / #23, and this branch.
- Program: unchanged since the devnet build (no diff under `programs/`, `Cargo.toml`, `Cargo.lock` since
  `v0.1.1-rc.2`). Tests ran against the released binary, sha256
  `e6112ffffdffb12817006ffe57856ad96d00f3ce84adb769baf126ddaaf37a5a` (matches the rc.2 `SHA256SUMS`).
- SDK / CLI: published `0.1.1-rc.2` (GitHub release tarball). The starter and oar-web pin it. `0.1.1-rc.3` is
  prepared (#22), not released. Local pack checksums: SDK `9a13cd3f…6b42`, CLI `5a792ab0…cc50`
  (`release/evidence/local-pack-v0.1.1-rc.3-2026-10-19.json`, not release assets).
- Starter requirements: Node ≥ 22 (tested 22.22.0 and 24.22.0), `create-solana-dapp@4.8.5` (npm `latest`).

## Fixed in this round

| Defect | Fix | Verified by |
| --- | --- | --- |
| Trusted-attestation RPC failure reported as `invalid` | `fetchClaimAttestation` → `unavailable`; claim stays `unverified` + retry | SDK test fails on old source, passes on new |
| CLI `inspect` on RPC outage: generic error | exit 2, JSON `{status:'unavailable'}` | CLI test against an HTTP 503 RPC |
| `devnet/oar-app.mjs` would sign a backlink write after a failed read | refuses; retries unavailable resolution | code review, `node --check` |
| Manifest URIs on branches/`HEAD` accepted | `checkManifestUri` in SDK, CLI `register`/`update`/`claim`, starter | SDK, CLI and starter tests (positive and negative) |
| `oar.json` usable as manifest location | reserved name, refused everywhere | same |
| Outage indistinguishable from "no proof" for consumers | `retryable: true` on `unverified` claims | SDK tests; CLI and oar-web display tests |
| Starter threw on RPC outage | `getProgramIdentity` → `verified \| unverified \| unavailable` | typechecks against rc.2 and new SDK |
| `create-solana-dapp` printed `+npm run dev` | commands on their own lines | test pins the `+`-at-start rule |
| pnpm users: `oar:prepare -- --creator` failed | scripts accept pnpm's forwarded `--` | tests; real `pnpm run` |
| Scanner false positive on `regex.exec(line)` | `line.match(regex)` | `pnpm security:check` |

## External template test results (create-solana-dapp@4.8.5)

| Check | Result |
| --- | --- |
| Download `gh:gwapupward-hub/oar/packages/create-oar-dapp/templates/nextjs#<sha>`, rename to the project name | PASS (`alpha-dapp`, `beta-dapp`, `gamma-node24`) |
| Install from the rc.2 tarball, no monorepo-relative paths | PASS on Node 22.22.0 and 24.22.0 |
| `typecheck`, `build` | PASS on both |
| `next start`: `/` 200 with "not registered" and "not a security audit"; unknown 404; no proof served | PASS (local and CI) |
| `oar:prepare` refuses empty domain, keypair path, mainnet, bad program ID, overwrite, `HEAD` manifest URI | PASS |
| Proofs valid against `schema/*-0.1.schema.json`; App IDs consistent | PASS |
| Two projects with different names/creators: no shared state | PASS |
| Anchor adapter: preview first, public IDs only, never the wallet path | PASS |
| No keys, signing or transaction code in generated sources | PASS |
| create-solana-dapp's optional "Solana dev skill" step | Failed in the sandbox (`npx skills`), reported as skipped by the CLI; not part of the template |

## Solana upstream validation (templates `d7961ba` + patch)

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` with pnpm 10.5.2 (upstream CI version), `--lockfile-only` | Lockfile up to date; diff adds only this importer and its closure (+128, −0) |
| `pnpm generate` | Adds only `oar-identity-starter` to `templates.json`, `TEMPLATES.md`, `.github/workflows/templates.json` |
| `pnpm lint` | All templates are valid; Prettier and `tsc` clean |
| `pnpm validate` | Validation passed |
| `pnpm security:check` | This template: 1 HIGH `dependency-remote-source` (advisory; workflow does not fail) |
| `pnpm health --only community/oar-identity-starter --boot` | build ✅ boot ✅; warn: outdated majors (`@types/node`, `typescript`) |
| `og-image.png` | 1200×630 PNG, 13,679 bytes, via `pnpm create-image "OAR App Identity"` (standard gallery layout) |
| Discovery | `templates.json` id `gh:solana-foundation/templates/community/oar-identity-starter`; listable by `create-solana-dapp` only after merge |

Risk: with pnpm 10.5.2 in this sandbox, fetching the SDK's GitHub release asset returns HTTP 401 on the redirect
(pnpm 10.28 and npm succeed). If upstream CI reproduces it, its frozen install fails. An npm-registry release of
the SDK removes this risk together with the security finding.

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

1. Merge oar-web#13 (#20, #21, #22 and #23 are merged).
2. Push tag `v0.1.1-rc.3` on `main` (GitHub pre-release by `release.yml`).
3. Publish `@open-app-registry/sdk` to the npm registry (removes the remote-source finding and the pnpm 10.5.2 risk),
   then point the starter, oar-web and the community template at it.
4. Sign the Devnet manifest update above.
5. Fork `solana-foundation/templates`, apply `docs/gallery-submission/0001-add-oar-identity-starter.patch`, push
   branch `community/oar-identity-starter`, and open the PR with `docs/gallery-submission/PR-DESCRIPTION.md`.

```bash
gh repo fork solana-foundation/templates --clone && cd templates
git checkout -b community/oar-identity-starter d7961ba
git am /path/to/oar/docs/gallery-submission/0001-add-oar-identity-starter.patch
# after the SDK is on npm: set "@open-app-registry/sdk": "<version>" in community/oar-identity-starter/package.json
pnpm install && pnpm generate && pnpm lint && pnpm validate && pnpm security:check
git push -u origin community/oar-identity-starter
```

## Unresolved risks

- The community template and starter depend on SDK rc.2, which reports a failed backlink read as `failed`. The
  starter's own helper turns that into `unverified` (never a failure badge), but oarprotocol.xyz still shows
  "Disputed / invalid" during an RPC outage until oar-web takes rc.3.
- The OAR CLI is not on npm; the README points CLI users to the repository.
- Upstream maintainers may ask for a different name, image or scope.

## Out of scope (mainnet gates, unchanged)

Independent program security audit, mainnet program ID, upgrade-authority transfer to Squads, governance timelock,
mainnet deployment, and owner-controlled key operations.
