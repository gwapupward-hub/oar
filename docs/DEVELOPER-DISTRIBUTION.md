# OAR Developer Distribution — external Solana CLI template

Status: **proposed release path**, independent of the OAR mainnet protocol
release. The template lives in the OAR repository at
`packages/create-oar-dapp/templates/nextjs`.

## Supported route

The Solana Foundation `create-solana-dapp` tool supports external GitHub
templates through `giget`:

```bash
npm create solana-dapp@latest -t gh:gwapupward-hub/oar/packages/create-oar-dapp/templates/nextjs
```

The template contains:
- an importable Next.js and @solana/kit frontend with server-only OAR resolver;
- `oar.config.json` (Devnet, no domain, no programs, no pre-claimed identity);
- the existing `oar:prepare` SDK wrapper and optional `oar:anchor` importer;
- `create-solana-dapp` display metadata, rename map for the starter app name,
  and onboarding instructions.

The name is updated by the Solana CLI's templating step. Developers extracting
the GitHub subdirectory by other means must edit `oar.config.json` manually.

## Pre-release acceptance

1. Complete the OAR repository's program, client and dependency jobs.
2. Confirm the generated project builds on Node 24, and test the direct
   extracted template without invoking the internal generator.
3. **After merging to main**, execute the actual Solana CLI external-template
   command in a clean throwaway directory on a machine with network access.
   Check that the package and OAR config rename correctly, dependencies install,
   `npm run build` succeeds, and the no-domain default fails closed before
   generating any manifest.
4. Set a domain controlled by the tester or an immutable supported manifest
   URI; prepare the manifest with **only** the public creator address.
5. Publish the site/proof files and verify their host responses. A test
   creator must explicitly sign a Devnet registration and an upgrade authority
   must separately sign each canonical program backlink.
6. Re-resolve the App ID in OAR and require `verified` states from actual
   bidirectional checks. Record signatures, slot, source commit, and failures.

Do not advertise the external template as tested by the **actual Solana CLI**
until acceptance item 3 is reproduced. OAR v0.1's account, manifest and
security gates remain unchanged.

## Official Solana gallery

The Solana Foundation templates repository has a separate
`community/` contribution process. It requires a template `package.json`
with `name`, `displayName`, `description`, `usecase`, `keywords`, and
an `og-image.png` of **1200x630 pixels** and **under 500 KB**.

Before submitting upstream:
- Run a fully independent clean-install template test and record it.
- Create a properly licensed preview image and validate dimensions/size.
- Review upstream contributor guide and package version compatibility.
- Prepare a community template folder, run `pnpm generate`/`pnpm lint`
  in the Foundation repo, and submit a PR for their review.
- Never claim Foundation endorsement until their maintainers actually accept it.

References:
- https://github.com/solana-foundation/create-solana-dapp
- https://github.com/solana-foundation/templates/blob/main/COMMUNITY_TEMPLATE_GUIDE.md

No npm publication, external PR, production deployment, or key operation is
included in this implementation.

## Automated external-distribution smoke

A separate GitHub workflow, `.github/workflows/external-template-smoke.yml`,
runs Solana's published `create-solana-dapp@4.8.5` against the **public main
branch**, verifies the generated project's name and fail-closed OAR config,
and independently installs, typechecks, and builds the project. It uses
no deployed keys and no write-scoped GitHub credentials.

It tests the public distribution path, not an onchain Devnet registration.
A failure blocks declaring the external template verified; fix the CLI or
template before promoting it to an official Solana community gallery
contribution. Repeat the smoke when changing the template or the supported
Solana CLI version. The workflow intentionally does not sign anything.
