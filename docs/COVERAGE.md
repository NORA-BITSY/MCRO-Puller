# Coverage methodology

Acquisition completion is not discovery completeness. Unknown source populations have `denominator = null`; never substitute zero or the number discovered. `observed` means a scoped search completed without known truncation, not statewide completeness. `partial`, `truncated`, `saturated`, `blocked` and `failed` remain visible.

| Dimension | Target / observable population | Method and confidence | Exclusions / recovery |
|---|---|---|---|
| Jurisdiction | All target states / registered sources | Source registry, explicit fixture flag | Unimplemented states; add tested adapter |
| Court | Courts within each system / observed source court labels | Distinct canonical cases, source registry | Missing inventories; compare authoritative list |
| Case type | All public types / supported source categories | Raw labels plus versioned mappings | Remotely unavailable types; record exclusion |
| Historical cases | Full public history / date-partition observations and imported feeds | Persistent partition scopes, caps and timestamps | Missing years, invalid broad queries; bounded backfill |
| Active cases | All active public matters / known observed status | Exact source status, historical transitions | Unknown population denominator; additional discovery sources |
| New cases | Newly filed matters / discovery window results | Independent recurring partitions with overlapping windows | Publication lag, search exclusions; overlap/revisit |
| Existing activity | Changes on known cases / successful refresh snapshots | Last successful observation and change records | Unobserved cases, source outages; priority retry |
| Docket events | Every source-exposed entry / captured snapshot entries | Raw sections, ordered entries, parser evidence | Parser ambiguity makes snapshot partial; reobserve |
| Document availability | Source-exposed references / observed refs and access states | Available/restricted/unavailable/unknown distinct | Index without attached PDF; do not invent document |
| Artifact acquisition | Available references / structurally valid checkpointed versions | Per-document state and SHA-256 | Download failures; durable child jobs |
| Text extraction | All acquired pages / extracted page records | Page method, quality, warnings | Scans/blank/unreadable; selective OCR/review |
| Interpretation | Source-grounded content / versioned extraction assertions | Exact page offsets and quotes, method/model version | No inference when model disabled; unsupported findings remain unknown |
| Freshness | Configured refresh due dates / last successful observations | Age and due backlog, not last attempt | Outages and insufficient source capacity; expose backlog |
| Search capabilities | All exposed source modes / validated implemented modes | `documented`, `fixture`, `live` evidence levels | Current live MCRO validation pending; source-specific contract runs |

Every coverage observation stores source, scope, count, denominator, status, limitations, timestamp and optional discovery partition. Scope includes query mode and actual compatible filters. Recursive splitting is attempted only for supported date filters, never guessed broad enumeration. A saturated one-day partition remains incomplete.

Case filings and latest docket activity are distinct clocks. Updating known cases cannot discover unknown ones. Bulk extracts are snapshots with their own population restrictions, not full dockets or PDF feeds.

Public source references: https://mncourts.gov/access-case-records/mcro/faqs ; https://mncourts.gov/_media/migration/mcro/handout-understanding-mcro-search-results.pdf ; https://mncourts.gov/help-topics/court-statistics/bulk-data . MCRO cap is 200, pending criminal name-search omissions exist, subscription extracts update weekly. No live all-case enumeration is established.
