# Open App Registry — Locked Product Principles

**Approved by the founder:** October 24, 2026  
**Status:** LOCKED product decisions. They govern OAR's protocol, SDK, CLI, explorer, APIs, integrations, pricing, copy, and future roadmap. Any change requires a new explicit founder decision.

OAR proves application identity and reciprocal control of related resources. It must remain an independently usable public infrastructure layer, including when GWAP products are its earliest adopters.

## 1. Verification is free and neutral

- Core verification and resolution of ownership proofs must be available without an OAR subscription or paid upgrade. Solana network transaction fees, if any, are separate from an OAR verification charge.
- A payment must never improve or change an application's verified/unverified/failed/unavailable status, proof strength, safety implication, trust badge, or treatment by a verification algorithm.
- Pricing, featured placement, sponsorship, and service tiers must never be presented as identity verification or higher trustworthiness.
- Potential future paid services are **monitoring**, developer and team tooling, higher-service APIs, operational support, and service-level guarantees. These services may improve convenience or reliability, not the underlying verification verdict.

## 2. An identity proof is not a security audit

- A valid OAR proof establishes a stated relationship, such as control of a domain, repository, or program backlink for a specific App ID and cluster. It does **not** establish that the app is safe, audited, legitimate in every respect, profitable, endorsed, or risk-free.
- User interfaces, APIs, documentation, and SDK examples must explicitly distinguish identity/control verification from security evaluations.
- Any future independent audit result or trusted-party attestation must be **separately labeled**, identify its issuer and scope, and communicate its own status and limitations. An attestation does not rewrite the base identity proof.
- Avoid visual treatments such as an undifferentiated “trusted” badge that could mislead users into treating a domain proof as an audit.

## 3. OAR must work outside GWAP

- OAR is public Solana infrastructure, not an exclusive GWAP identity service. External applications and third-party developers must be able to register, resolve, and verify through the published protocol and SDK without using GWAP accounts, products, websites, or proprietary scoring.
- GWAP applications may be the first pilots and integrations, but receive **no preferential verification logic, trust weighting, privileged proof rules, or hidden fast path**.
- Prefer open, documented schemas, deterministic verification rules, and portable SDK/API interfaces. OAR integrations with GwapSpot OS, GNS, GwapScore, PPV, or RoyaltyRails are downstream consumers, not requirements to use OAR.
- Neutral governance and independent security review remain future milestones before Mainnet. Mainnet is not implied by adoption or gallery inclusion.

## Release and product-review acceptance checklist

Every feature, pricing change, UI badge, API revision, integration, and partnership should answer:

1. Does the exact same proof receive the exact same verification result for paying and nonpaying users?
2. Could a reasonable user mistake this identity/control proof for a security audit or endorsement? If so, relabel it.
3. Can a non-GWAP developer independently register and verify the same relationship using public documentation and SDKs?
4. Are any issuer-backed attestations separate from core OAR identity and clearly attributed?
5. Are operational, governance, privacy and mainnet readiness gates still enforced?

These principles are **product commitments**, not a claim that every proposed paid feature, independent audit, or integration has already shipped.
