# Registering an existing app

This guide is for a team whose app is already live: a site, possibly programs, possibly a public repository. Registration gives the app one permanent App ID, and each link to it becomes verified once you prove it from the side you already control.

**Status:** devnet only. The registry is not deployed on mainnet yet (see `docs/PRODUCTION-READINESS.md`).

## What you sign, and why it is safe

| Step | Who acts | What it proves | Cost |
| --- | --- | --- | --- |
| Deploy two files to your site | Whoever deploys the site | You control the domain, and the manifest is served where the record will point | None |
| `register` transaction | Any wallet you choose as **creator** | Creates the App ID. It is derived from the creator, so nobody else can take it | About 0.0039 SOL rent |
| One program-link transaction per program | That program's **upgrade authority** (a wallet or a Squads vault) | The program points back to this App ID | Rent for a ~200-byte account |
| Commit `oar.json` to a repository (optional) | A repository maintainer | You control the source repository | None |

- **No custody.** Nothing in this flow holds your keys. The CLI signs locally, and a multisig gets an unsigned transaction to approve.
- **Plain-language previews.** Every transaction is summarized before anything is signed.
- **Only registry programs.** Tooling refuses to sign any instruction outside the OAR registry, Program Metadata, System and Compute Budget programs (`assertRegistrationInstructions`). A registration request that asks for anything else is not genuine.
- **No secrets.** OAR never asks for a seed phrase, a private key or a keypair file. Neither does any page claiming to register you.
- **A record proves nothing alone.** Anyone can register an App ID that *claims* your domain or program. It stays "Unverified" forever, because only you can publish the proofs. You never need to dispute it: register your own.

## Steps (CLI)

```bash
npm i -g @open-app-registry/cli     # or: node packages/cli/dist/index.js

# 1. Derive the App ID and write the files (uses the first unused nonce for the creator)
oar claim prepare --creator <CREATOR_PUBKEY> --name "My App" \
  --domain myapp.xyz --program <PROGRAM_ID> --repo https://github.com/me/myapp \
  --category defi --authority <SQUADS_VAULT>     # authority is optional; a vault is recommended for production
```

`prepare` writes `oar-claim/`:

| File | Where it goes |
| --- | --- |
| `site/.well-known/oar-manifest.json` | `https://myapp.xyz/.well-known/oar-manifest.json`. The manifest, committed onchain by hash |
| `site/.well-known/oar.json` | `https://myapp.xyz/.well-known/oar.json`. The domain proof |
| `repo/oar.json` | Root of each listed repository, on the default branch. The repository proof |
| `claim.json` | Stays with you; the next commands read it |

Copy `site/.well-known/` into your site's public directory and deploy. Both files must be served with status 200 and **no redirects**.

```bash
# 2. Check everything before signing anything
oar claim check

# 3. Create the App ID (the creator signs; prints a summary and signs only with --yes)
oar claim register -k <CREATOR_KEYPAIR> --yes

# 4. Link each program (its upgrade authority signs)
oar claim link-program <PROGRAM_ID> -k <UPGRADE_AUTHORITY_KEYPAIR> --yes
# or, when a Squads vault is the upgrade authority: prints an unsigned transaction to import as a proposal
oar claim link-program <PROGRAM_ID> --squads <VAULT>
```

Then confirm with `oar inspect <APP_ID>`, or open the app's page on the explorer.

`register` refuses until the manifest is served and matches byte-for-byte (same canonical hash). Registering first would leave the record showing "metadata unavailable".

## Where to host the manifest

The record stores the manifest's SHA-256. The host can therefore change nothing without the check failing, and the choice of host affects only availability.

- **Default:** `https://<your domain>/.well-known/oar-manifest.json`. It ships in the same deploy as the domain proof, adds no new dependency, and is available whenever your site is.
- **Alternatives:** `ar://` or `ipfs://`, for a copy that outlives the site. Pass `--manifest-uri`.

To change the manifest later, edit it, deploy it, then run `oar update` as the record authority. The App ID never changes.

## Programs: what can and cannot be linked

- **Upgradeable programs:** the upgrade authority writes the canonical Program Metadata account (seed `oar`). It is plain JSON, readable in the transaction: `{"oar":"0.1","app":"<APP_ID>","cluster":"solana:devnet"}`. It changes no code and no authority.
- **Squads-held programs:** `--squads <vault>` builds the same instructions with the vault as signer and payer. The vault needs SOL for the rent.
  - **For approvers:** check that the App ID in the content matches the one on the explorer before approving.
- **Frozen programs** (no upgrade authority) and non-upgradeable programs cannot write a canonical backlink. They can be linked only by a trusted issuer's attestation, which is not available yet.
  - Teams planning to freeze a program should link it first.

## For integrators

The same steps are available from the SDK. Browser code should import the entry point that uses no Node APIs:

```ts
import {
  nextAppNonce, describeRegistration, getProgramLinkInstructions, describeProgramLink,
  exportUnsignedTransaction, assertRegistrationInstructions,
} from '@open-app-registry/sdk/register';
```

`checkManifestHosting` (in the main entry point) runs on a server, using the SDK's protected HTTP transport.
