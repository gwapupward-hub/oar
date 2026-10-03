# OAR Brand System v1.0

This document defines the canonical public identity for **OAR — Open App Registry**.

> **Open by default. Verifiable by design.**

OAR is neutral developer infrastructure for publishing, discovering, and verifying evidence about onchain application identity. The brand must communicate openness, technical credibility, composability, and evidence without implying a blanket safety certification.

## Canonical naming

- **Institutional/product name:** `OAR` or `Open App Registry`
- **Developer treatment:** lowercase `oar` for CLI, SDK, code, package, and terminal-oriented surfaces
- Do not rename the project to “Solana OAR” or otherwise imply that OAR is operated or endorsed by Solana unless a formal relationship exists.

## Primary tagline

**Open by default. Verifiable by design.**

## Canonical mark

The Registry Ring is the canonical OAR mark. Use the supplied source assets in `brand/logos/`; do not redraw the mark from screenshots or reference boards.

### Usage rules

- Preserve logo proportions and node placement.
- Keep clear space around the mark of at least one node diameter.
- Use only the canonical palette unless an approved monochrome treatment is required.
- Use the light lockup on light surfaces and the dark lockup on dark surfaces.
- Use the lowercase developer lockup for CLI/SDK-oriented surfaces.
- Do not add Solana marks, gradients, endorsements, shields, checkmarks, or third-party branding to the OAR mark.

## Palette

| Token | Hex | Purpose |
| --- | --- | --- |
| OAR Midnight | `#07111F` | Primary dark surface |
| Registry Blue | `#246BFD` | Primary action / registry signal |
| Open Cyan | `#22D3EE` | Open/link signal |
| Verified Mint | `#42E8B4` | Confirmed evidence state |
| Cloud | `#F5F8FC` | Light surface |
| Slate | `#8B99AA` | Secondary text / neutral state |
| White | `#FFFFFF` | Contrast / light content |

Machine-readable tokens live in `brand/tokens/`.

## Typography

- **Primary UI / brand:** Inter
- **Developer / CLI:** Geist Mono preferred; IBM Plex Mono acceptable fallback
- Font files are not committed to the repository. Use licensed or system-delivered sources.

## Evidence language

OAR surfaces evidence. It does **not** centrally certify that an application is safe, legitimate, secure, or officially approved.

Prefer evidence-specific states such as:

- Published
- Domain linked
- Program linked
- Source available
- Build reproduced
- Attested
- Unknown
- Disputed / invalid

Do **not** collapse these into a blanket **Verified App** badge.

A state must describe evidence the implementation can actually substantiate. Product copy must not get ahead of the protocol or release state.

## Current release-state constraint

Branding does not change the engineering release status. Until the production readiness gates documented in `docs/PRODUCTION-READINESS.md` and `docs/RELEASE-RUNBOOK.md` are satisfied, public materials must not imply that OAR is production-deployed or security-certified.

## Repository assets

- `brand/logos/` — canonical SVG logo and developer lockups
- `brand/icons/` — app/fav icon exports
- `brand/tokens/` — palette and typography tokens
- `brand/copy/` — canonical messaging and evidence-state language

The complete distribution kit, including the PDF brand guide, social/reference exports, and duplicate raster sizes, should be published as a release artifact rather than committed to normal source history.

## Version

**OAR Brand System v1.0 — 2026-10-03**
