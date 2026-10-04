# OAR internal pre-review — October 4, 2026

> **Not an independent review.** The same engineering session that prepared the release wrote this. It narrows what an external reviewer has to chase. It does not satisfy the independent-review gate.

**Scope:**
- the program `programs/oar-registry/src` at `9329e0d` (deployed on devnet);
- the SDK verifier `packages/sdk/src/{attestations,links,resolve,manifest,http}.ts`;
- the CLI signing path `packages/cli/src/tx.ts`;
- the operator scripts `scripts/devnet/`;
- CI `.github/workflows/ci.yml`.

**Method:**
- manual read of every instruction against the Anchor account-validation checklist;
- a trace of every SDK path that can return `verified` or `attested`;
- runtime checks of the confirmed issues with SAS accounts encoded by `sas-lib` 1.0.10;
- SAS semantics checked against the upstream program source (create and version-change schema, create attestation, account discriminators).

## Verdict

- **Devnet:** GO, already deployed and verified.
- **Mainnet:** NO-GO.
  - No program finding blocks it.
  - The remaining blockers are the open gates: an independent review, Squads governance and operations. The SAS rehearsal and the dependency and CI hardening are done.
  - OAR-IR-01, OAR-IR-02 and OAR-IR-04 are fixed. OAR-IR-03 and OAR-IR-06 are addressed in the spec and the CLI. OAR-IR-05 stays open as the governance gate.

**Status update, October 4, 2026 (repository hardening for `v0.1.1-rc.1`):** OAR-IR-02, OAR-IR-03, OAR-IR-04 and OAR-IR-06 were resolved after this review was written. Each finding below records how.

## Findings

### OAR-IR-01 — Attestations stayed valid after their signer was removed from the credential (Medium, fixed)

- **Confidence:** high.
- **Evidence:** `packages/sdk/src/attestations.ts`, `fetchClaimAttestation`. It checked the schema, nonce, payload and time, but never `att.signer`. Upstream SAS checks the signer against `credential.authorized_signers` only inside `create_attestation`. `change_authorized_signers` does not touch issued attestations.
- **Failure path:**
  1. An issuer's signing key is compromised.
  2. The attacker issues correctly shaped evidence for claims they control the subject of.
  3. The issuer removes the key with `change_authorized_signers`.
  4. Every attestation that key issued still resolves as `attested` until it expires (up to 90 days for programs), unless the issuer finds and closes each one.
- **Impact:** a false `attested` badge for any client that trusts that credential, persisting after the containment step the issuer controls.
- **Fix:**
  - `fetchClaimAttestation` now reads the credential account. It must be SAS-owned and have discriminator 0 (`decodeCredentialSigners`). An attestation whose signer is not currently authorized is `invalid`.
  - The spec makes this a client MUST.
- **Regression test:** `packages/sdk/test/hardening.test.ts` → "evidence from a signer the credential no longer authorizes fails closed". It covers:
  - a removed signer, and an empty signer list;
  - a closed credential, and a credential with the wrong owner;
  - any one of several current signers is still accepted;
  - the resolve-level `attested` → `unverified` transition.
- **Cost:** one extra finalized `getAccountInfo` per attestation lookup.

### OAR-IR-02 — Duplicate JSON keys hash identically and parse differently across implementations (Low, fixed)

- **Confidence:** high for the behaviour, medium for the impact.
- **Evidence:** manifests, proof files and backlinks go through `JSON.parse` (`manifest.ts:155`, `links.ts:75,138,202`), which keeps the **last** duplicate key. The hash is then taken over the canonicalized parsed value. Checked:
  - `{"name":"Trusted Wallet","name":"Other"}` and `{"name":"Other"}` hash to the same value;
  - JS reads `name` as `Other`.
- **Failure path:** a manifest author publishes duplicate keys. A client in another language that keeps the **first** duplicate, or rejects duplicates, sees different content under the same on-chain hash.
- **Impact:**
  - Display inconsistency between implementations.
  - It cannot forge a link: every claim is still verified independently in both directions, and only the record authority can publish the hash.
- **Remediation:**
  - The spec should say manifests, proof files and backlinks MUST NOT contain duplicate keys, and verifiers MUST reject them.
  - The SDK should parse with duplicate-key detection before hashing.
- **Regression test:** a manifest with a duplicate key resolves as `schema` (invalid), not `ok`.
- **Fixed:**
  - `packages/sdk/src/json.ts` `parseJsonStrict` parses as before, but throws `DuplicateKeyError` for a repeated member name in any object. Names are compared after unescaping.
  - `fetchManifest`, the Program Metadata backlink and the well-known and `oar.json` proof files all use it. A duplicate-key manifest resolves as `schema` invalid, a backlink as `failed`, and a proof file as not verified.
  - The CLI reads manifests strictly, so `oar validate`, `oar hash` and `oar register` refuse them.
  - The spec makes the rule a MUST for manifests and proofs.
  - Tests:
    - `packages/sdk/test/manifest.test.ts` (parser cases);
    - `packages/sdk/test/resolve.test.ts` → "repeated JSON keys invalidate the manifest and the backlink even when the hash matches";
    - `packages/cli/test/release.test.ts`.

### OAR-IR-03 — `AppRecord.authority` is not an endorsement by that key (Informational, addressed)

- **Evidence:** `register` (`lib.rs:42`) accepts any non-zero `authority` without that key signing. This is intended, because it lets a Squads vault be named at creation.
- **Risk:** a UI that displays "authority: <well-known key>" as social proof could be misled by a squatter's record naming a famous key.
- **Remediation:** the spec display rules should state that `authority` proves control only after that key has signed an update. Clients should not present it as identity. No program change.
- **Addressed:** spec display rule 8 (`docs/spec-v0.1.md`).

### OAR-IR-04 — CI supply-chain hardening (Low, fixed)

- **Evidence:**
  - `.github/workflows/ci.yml` uses `actions/*@v4` by tag, not by commit SHA. The runners also warn that these Node 20 actions are deprecated.
  - CI runs no Rust advisory or license scan (cargo-deny or cargo-audit).
- **Remediation:**
  - Pin the actions to reviewed SHAs.
  - Add `cargo deny check advisories bans licenses sources` against `Cargo.lock` and `tools/idlgen/Cargo.lock`.
  - Record the result as the `dependencyReview` evidence.
- **Fixed:**
  - Every action in `.github/workflows/` is pinned to a full commit SHA, on the Node 24 releases. Checkouts no longer persist credentials, and run steps use bash with `pipefail`.
  - Dependabot (`.github/dependabot.yml`) proposes pin updates as reviewed PRs.
  - The new CI job `dependencies` runs `cargo-deny` 0.20.2, a checksum-verified release binary, on both lockfiles with `deny.toml`:
    - advisories, yanked crates, licenses (allow-list), wildcard bans and sources (crates.io only);
    - one reviewed exception: RUSTSEC-2025-0141, unmaintained `bincode` 1.3.3. It is not a vulnerability, it reaches the program only through `anchor-lang` 1.2.0 and the `solana-*` crates, and no safe upgrade exists.
  - The same job runs `npm audit` at level low and `npm audit signatures`. It uploads the reports, and each release attaches them.
  - `.github/workflows/release.yml` reruns this full gate on the release commit before it tags.

### OAR-IR-05 — Single-key upgrade authority on devnet (Informational; a known gate)

On devnet, both upgrades and the canonical `oar` and `idl` metadata are controlled by one hot key, `2iceQADt…`. Mainnet requires a Squads multisig, rehearsed on devnet, with the threshold and members recorded.

### OAR-IR-06 — The CLI confirms at `confirmed` while the SDK resolves at `finalized` (Informational, addressed)

- **Evidence:** `tx.ts:43`. `sendAndConfirm` returns at `confirmed`, and it throws "Timed out waiting for <signature>" after 60 s even if the transaction later lands. Resolution reads `finalized` state.
- **Risk:** an operator may see "No AppRecord" right after `register`, or may re-send an `update` after a timeout, which bumps the revision twice. Integrity is unaffected.
- **Remediation:** document that a timeout means "check the printed signature before retrying". Optionally, poll to `finalized` in the CLI.
- **Addressed:** the timeout error now reads "Timed out waiting for <signature> after 60s. It may still land: check it (solana confirm <signature>) before retrying." Covered by `packages/cli/test/release.test.ts`. Polling to `finalized` is not added.

## Reviewed with no findings

- **Program:**
  - **`register`:** `init` with seeds `["app", creator, nonce]` and payer = creator signer, so squatting is impossible. It validates the URI (1–256 bytes, printable ASCII 0x21–0x7E), the hash (non-zero) and the authority (non-zero).
  - **Authority-gated instructions:** `update_manifest`, `propose_authority` and `set_status` use `AuthorityOnly` with `has_one = authority` and a signer. Each first rejects retired records.
  - **`accept_authority`:** requires a pending authority equal to the signer.
  - **State and limits:** `revision` uses `checked_add`. `set_status` bounds status to 2 or less, and retirement clears the pending authority.
  - **Accounts:** the AppRecord size is fixed at 427 bytes with no realloc. There is no close path, so no double-close or rent drain. Every record account is typed `Account<AppRecord>` (owner and discriminator checked) and there are no CPIs.
- **SDK record resolution:** it checks owner, discriminator, exact size, layout version, status, URI length and the PDA/bump re-derivation before trusting a record (`resolve.ts:83`).
- **Program Metadata backlinks:** canonical only, direct data source, JSON, UTF-8, at most 16 KiB before and after zlib or gzip inflation, `program` field bound (`links.ts:43`).
- **Schema checks:** discriminator 1, credential binding, exact name, layout, field names and version, and not paused (`attestations.ts:150`). This was cross-checked against upstream SAS: discriminators Credential 0, Schema 1, Attestation 2. `create_schema` starts at v1, and `change_schema_version` adds one and copies the name.
- **Network:**
  - every hop is checked; only HTTPS on port 443, with no userinfo;
  - the IPv4 and IPv6 special-use exclusions are conservative;
  - DNS answers are all validated, then the first is pinned into the TLS connection while the original hostname is still verified;
  - one deadline covers the whole fetch, and bodies are capped (`http.ts:26-133`).
- **Operator scripts:** they pass keypair paths, never contents, except where the CLI loader is reused in memory. The scripts refuse non-devnet genesis hashes, never use `--final`, and never close buffers or generate program keys. Evidence files contain only public data, and `check:source` blocks signer-shaped files.

## Follow-ups for the external reviewer

Re-check the fixes for OAR-IR-01, OAR-IR-02 and OAR-IR-04, and the spec rules added for OAR-IR-02 and OAR-IR-03. Then cover the "Requested depth" areas in `docs/SECURITY-REVIEW-SCOPE.md`, against the final mainnet commit.
