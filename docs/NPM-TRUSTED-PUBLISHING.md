# SDK npm trusted publishing — owner handoff

The initial `@open-app-registry/sdk@0.1.1-rc.3` release was published by the owner using npm staged publishing. Do **not** attempt to stage or republish the same version.

## Security model

- The GitHub workflow `.github/workflows/npm-publish.yml` only runs by manual dispatch on `main`.
- The workflow verifies a release-candidate version, the package versions, and an existing GitHub release/tag pointing at exactly the selected commit.
- It stages **only** `@open-app-registry/sdk` with the `next` dist-tag. It cannot publish directly or stage the CLI.
- GitHub-hosted Actions obtains short-lived npm publishing authority through OIDC; no npm access token, private key, or creator wallet belongs in this repository.
- An npm maintainer must review and approve the stage with 2FA before the version is publicly available.
- No GitHub workflow deploys an onchain program or signs an OAR record.

## One-time setup (npm package owner, on npmjs.com)

**Timing:** npm requires the first OIDC publication using a newly configured trusted publisher within 2 days. Configure this *when the next new SDK version is ready to stage*, not weeks in advance.

1. Go to `https://www.npmjs.com/package/@open-app-registry/sdk` → **Settings** → **Trusted Publisher** → GitHub Actions.
2. Enter **Organization/user:** `gwapupward-hub`; **Repository:** `oar`; **Workflow filename:** `npm-publish.yml` (not the full path).
3. Leave **Environment** empty unless the workflow is deliberately updated to use the same GitHub Environment.
4. Permit **stage publishing only**. Do not enable direct `npm publish` or dist-tag management from CI.
5. Save; ensure `npm-publish.yml` is merged into `main` before attempting validation.

After successful OIDC staging, switch package **Publishing access** to **Require two-factor authentication and disallow tokens**, and revoke any leftover agent/CLI tokens. Verify the trusted publisher still works. Maintain a separate owner-controlled recovery path.

## Each subsequent SDK release

1. Review code, tests, README, and `npm pack --dry-run`. Increment the SDK **and root** package versions together, commit and merge to `main`. Never reuse an npm version.
2. Run existing **Actions → Release** with the new version on `main`; wait for checksums and GitHub release assets.
3. Run **Actions → Stage OAR SDK on npm** on `main`, entering exactly that unpublished version. This is the OIDC staging run; it does not make the package public.
4. In your owner-controlled npm session, inspect and approve the staged package using 2FA.
5. Verify, for example: `npm view @open-app-registry/sdk@0.1.1-rc.4 version` and `npm dist-tag ls @open-app-registry/sdk`. The `next` tag should point to the newly approved release candidate; `latest` is not managed here.

## Do not confuse release systems

The existing `.github/workflows/release.yml` builds and publishes **GitHub** release assets, not npm packages. The new `npm-publish.yml` requires that GitHub release first and only **stages** a new npm SDK version. npm owner approval is a separate action.

Mainnet remains **NO-GO** pending the independent program-security/governance gates in `docs/PRODUCTION-READINESS.md`.
