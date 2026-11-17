# src AGENTS.md — legacy browser pipeline (mcro / cli.js)

This directory holds the **legacy browser pipeline** (bin `mcro`, root `cli.js`): Playwright scrape → local files under `downloads/`. It is **preserved**, not the durable product. The durable product is `src/platform/` (bin `courtctl`).

## Files

| File | Responsibility |
|---|---|
| `cli.js` | Commander CLI: `search/download-case/bulk-download/sync/statewide/daemon/verify/ocr/status/counties`; `buildSearchQuery()` maps flags → `CourtSearchQuery` fields |
| `browser.js` | `createBrowserClient()` — Playwright Chromium, system Chrome discovery, standalone/extension mode, **masks `navigator.webdriver` + `--disable-blink-features=AutomationControlled`**, session file (`COURT_SESSION_FILE` / `~/.mcro-puller/session.json`) |
| `waf.js` | `ensureTermsAccepted()` (clicks MN terms modal when present; no longer refuses/throws `blocked`), `checkWafBlock()` (detects blocks/CAPTCHAs, throws `blocked`, does not solve/bypass) |
| `search.js` | `executeSearch()`, `validateSearchOptions()` — validated search modes (case, party, business, attorney, document, hearing, judgment) |
| `roa.js` | Register of Actions parsing; legacy ROA shape |
| `crawler.js` | `crawlCase()` — case detail + document navigation |
| `downloader.js` | `verifyPdfBuffer()` — PDF header/magic-byte checks (`%PDF`), row-dependent key, end-of-case manifest |
| `state.js` | local JSON state (`MCRO_STATE_FILE` / `~/mncourt-data/state.json`) |
| `queue.js` | `WorkerQueue` — in-memory legacy queue |
| `sync.js` | `syncCase()`, `syncAllActiveCases()` |
| `statewide.js` | `crawlStatewideActiveCases()`, `validateDiscoveryQuery()` |
| `ocr.js` | `preprocessPdf()` — Poppler/Tesseract; retains sidecars for legacy callers |
| `nlp.js` | `synthesizeCaseDossier()` — regex extraction, JSON templates |
| `models.js` | legacy data models |
| `counties.js` / `counties.json` | Minnesota county list |
| `config.js` | `CONFIG` — MCRO URLs (`publicaccess.courts.state.mn.us`), output dir, pacing delays (min 8s / max 20s default), `maxRetries` (3), `concurrency` (10, hard ceiling), `proxyPool` from `COURT_PROXIES`/`COURT_PROXY` |

## Key facts

- `cli.js` is **never typechecked** (`checkJs:false`); only `test/*.test.js` guard it (`node --check cli.js` in `pnpm check`).
- Legacy `downloads/` manifests are `docketComplete=false` — do not infer a full docket.
- `node cli.js --help` remains for local acquisition; the PostgreSQL platform is the durable cloud path.
- Obsolete proxy and unsupported filter-only statewide enumeration commands were **removed**, not retained as misleading aliases.
- No legacy `pull`/`run` commands exist.

## Safety (from AGENTS.md / README)

- `ensureTermsAccepted` accepts the terms modal automatically; a visible modal no longer halts work.
- `checkWafBlock` detects blocks/CAPTCHAs and throws `blocked`; does not solve or bypass. On `403`/`429` pause — do not retry or rotate identity.
- README claims "No proxy rotation, stealth plugin, CAPTCHA solver, or unattended challenge bypass," yet `browser.js` masks automation flags and `config.js` supports `COURT_PROXIES`/`COURT_PROXY` and `scripts/decodo-provision.mjs` provisions sticky US residential proxies. CAPTCHA/challenge bypass and header/referer spoofing remain out of scope; require explicit owner sign-off before adding them.
