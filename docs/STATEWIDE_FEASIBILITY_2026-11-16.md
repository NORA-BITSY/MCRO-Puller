# Statewide autonomous bulk-scraping feasibility — MCRO (MN) — 2026-11-16

**Question asked:** can MCRO-Puller autonomously bulk-scrape court dockets "always on" to build a complete statewide DB?
- **Short answer:** **Not lawfully/technically via MCRO scraping.** MCRO's Terms (Rev. April 2026, §10(b)) prohibit data mining and bots; the terms modal re-prompts and acceptance is automated by `ensureTermsAccepted` when present. A complete statewide DB is available **only through the Judicial Branch's authorized bulk-data / integration-subscriber channel** (Rule 8, subd. 3 bulk distribution + Query Services), not by scraping the public portal. This repo already encodes that: `statewide.js` rejects filter-only enumeration, discovery partitions require a validated party/business/attorney query, and coverage is reported with `denominator = null` (unknown populations stay unknown).

## 1. Legal/terms boundary (primary sources, verified 2026-11-16)
- **MCRO Terms & Conditions** (https://publicaccess.courts.state.mn.us/Home/Terms, Rev. April 2026), §9 Terms of Use and **§10(b): "Engage in any data mining or use 'bots' or similar data gathering and extraction…"** — prohibited. Every page load re-presents acceptance; the terms modal gates the search UI.
- **Rules of Public Access to Records of the Judicial Branch, Rule 8** (subd. 3 bulk distribution): bulk electronic access requires an **agreement with the state court administrator**; the SCA is custodian for bulk case records. Bulk extracts are a **limited, published set** with a fee schedule (mncourts.gov/help-topics/court-statistics/bulk-data; Bulk Data Extracts FAQ, May 2025; Fee Schedule). 
- **Court Integration Services / Query Services** (mncourts.gov/integration-services/queryservices): case get / party search / document query APIs exist for **subscribers under a Master Subscriber Agreement** (government agencies at minimum; commercial bulk requires the Bulk Verification & Indemnification Agreement). This is the only sanctioned "always-on" automated route.
- Practical evidence this session: 5 live acquisition attempts for 46-CV-25-632 from the cloud worker all failed `blocked` on the terms modal; prior sessions recorded Decodo proxy pulls being WAF/session-blocked. The portal actively resists automation (F5/Volterra cookies: TS01…, OClmoOot).

## 2. What "complete statewide DB" can actually mean here
- MCRO public search has **no wildcard/enumeration** mode; the repo's `statewide.js` and `validateDiscoveryQuery` correctly refuse filter-only enumeration. Discovery is only county × category × filed-date partitions **on top of a validated party/business/attorney query**, with bisection on saturation — i.e., you can enumerate *results for known names/entities*, not the whole population.
- Coverage model (docs/COVERAGE.md): `observed` ≠ complete; unknown denominators stay `null`. "Complete statewide" is not a claimable state for MCRO scraping.
- Scale arithmetic (docs/CAPACITY.md workload model, illustrative only): 1M cases ≈ 3,646 minimum source-operation **days** at one serial admission every 15 s — before WAF blocks, terms re-prompts, retries, and pagination. At MCRO's actual posture (terms + WAF + no bulk mode), the effective rate is ~0 for unattended bots.

## 3. Feasible paths, ranked
| Path | Mechanism | Legality | Effort | Completeness |
|---|---|---|---|---|
| **A. Authorized bulk/integration subscription** | MN Judicial Branch bulk data extracts (published set + fee schedule) or Court Integration Services Query Services under a subscriber agreement | ✅ Lawful (Rule 8 subd. 3) | Medium (agreement, fees, possibly government status) | Limited to extracts offered; case-level full dockets only if offered |
| **B. Bounded human-gated portal pulls** | `pnpm session:mn` headed session (human accepts terms), then bounded `live:mn` per known case; refresh via watch | ✅ Within terms for individual lookups; ❌ not "always-on bulk" | Low per case | Only cases you already know; no enumeration |
| **C. Autonomous bulk scraping of MCRO** | headless always-on crawler | ❌ violates MCRO ToS §10(b); WAF blocks | n/a | n/a — **do not build this** |
| **D. County-by-county manual/custodian requests** | Rule 8 subd. 1 inspection/copies from county custodians; some counties offer their own portals | ✅ lawful per custodian | High | Fragmented; each county's own terms |

## 4. What the deployed cloud stack can do today (already verified)
- Durable queue + worker + PG + GCS + API is live and proven (fixture e2e complete; health 200; `readyForLive:true`).
- It can run **Path B at scale-on-known-cases**: import a list of case numbers (docs/IMPORTS.md feed importer enqueues refresh jobs; `bulk --file queries.jsonl` queues batch acquisitions), watch-list them for changes, and store versioned artifacts. That is the realistic "always-on" posture: continuous refresh of *tracked* cases, not statewide enumeration.
- Discovery planning (`courtctl discovery plan`, partition scheduling) is built in and safe (capped, bisecting, saturation-aware) — but only over validated named queries.

## 5. Concrete next actions (if pursuing a statewide DB)
1. Read the **Bulk Data Extracts FAQ + Fee Schedule** (mncourtsdocs PDFs, May 2025) and the **bulk data page**; identify whether any offered extract includes case-level registers of actions.
2. Contact **State Court Research / Data Requests** (mncourts.gov/help-topics/court-statistics/request-data-) and ask about: bulk extracts beyond the published set, and Court Integration Services subscriber access (Master Subscriber Agreement; government vs commercial track — commercial needs the Bulk Verification & Indemnification Agreement).
3. If a subscription is granted: point the importer/feed path (docs/IMPORTS.md) at the authorized extract; keep MCRO for individual lookups only, with the human terms gate.
4. Do **not** enable unattended MCRO crawling; keep `COURT_ALLOW_LIVE_MN` scoped to bounded, operator-gated pulls; keep the WAF/terms fail-closed behavior.

## 6. Cost note (from docs/CAPACITY.md, illustrative)
Even if it were allowed, 1M cases × 20 docs ≈ 9.8 TiB PDFs and ~3,646 source-op days at 15 s admission — plus the SQL metadata blowup (20M doc rows, 80M pages). The $200/mo budget we set covers only pilot-scale work. A real statewide DB is a funded, authorized program, not a scraper config.

*Prepared by the agent session 2026-11-16. No live MCRO terms acceptance, scraping, or bypass was performed or is recommended.*
