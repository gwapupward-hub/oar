# create-oar-dapp

OAR App Standard v0.1 reference project generator. This package is an independent prototype,
not yet published to npm. Run from the OAR repository:

```bash
node packages/create-oar-dapp/bin/create-oar-dapp.mjs my-app --name "My App" --domain myapp.xyz --repo https://github.com/me/my-app
cd my-app
npm install
npm run dev
```

After selecting the PUBLIC wallet that will create the App ID on Devnet:

```bash
npm run oar:prepare -- --creator YOUR_PUBLIC_SOLANA_ADDRESS
```

The generator creates a Next.js starter and `oar.config.json`; preparation uses the existing
OAR SDK to derive the App ID, validate the manifest, and generate domain/repository proofs.
It does not sign, fund, deploy, publish or verify anything onchain.

Read `docs/OAR-APP-STANDARD-v0.1.md` and the generated project's README.
