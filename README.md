# MCRO-Puller

Rate-limited browser automation for searching Minnesota Court Records Online (MCRO), downloading publicly available case PDFs, maintaining local case manifests, and producing OCR/text-analysis artifacts.

The application does **not** bypass access controls. It detects block/error pages, stops affected work, and returns a failing exit code. Operators remain responsible for MCRO terms, applicable law, privacy obligations, and an appropriate request rate.

## What it does

- Searches case-number, citation, person, business, attorney, bar-number, filed-date, status, category, county, DOB, hearing-date, and judicial-officer fields exposed by the supported MCRO views.
- Downloads public docket PDFs through the authenticated browser context.
- Keeps each case in an isolated directory with a versioned manifest and SHA-256 hashes.
- Verifies existing files before skipping them; missing, truncated, or hash-mismatched files are downloaded again.
- Synchronizes tracked active cases and reports partial runs as failures.
- Splits statewide county/category/date searches when MCRO returns the 200-result cap. A still-capped one-day slice fails explicitly rather than claiming complete coverage.
- Extracts embedded PDF text, falls back to per-page Tesseract OCR, and writes deterministic filing/case dossiers and bounded LLM-ready chunks.

## Requirements

- Node.js with `pnpm`
- Chrome plus the Playwriter extension for `extension` mode, or Playwright Chromium for `standalone` mode
- For OCR: Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) and Tesseract

macOS:

```bash
brew install poppler tesseract
pnpm install
pnpm test
```

## Browser modes

### Extension mode

Default. Connects to an existing Chrome context through Playwriter and opens a dedicated page. Chrome and the Playwriter extension must already be running.

```bash
node cli.js search --case 27-CV-24-1 --mode extension
```

### Standalone mode

Launches an isolated Chromium context. Session state is read from and can be saved to `~/.mcro-puller/session.json` by the browser client.

```bash
node cli.js search --case 27-CV-24-1 --mode standalone --headed
```

An optional proxy list can route standalone bulk workers. Proxy routing is not a permission mechanism and must not be used to evade a block. Failed or blocked proxies are quarantined; the queue stops rather than silently falling back to the host IP when no configured proxy remains healthy.

## CLI

### Search

```bash
node cli.js search --case 27-CV-24-1
node cli.js search --citation 882606190625
node cli.js search --name Anderson --first John --county Hennepin --category CV --status Active
node cli.js search --business "Example Holdings LLC"
node cli.js search --attorney Smith
node cli.js search --bar 0392011
node cli.js search --judge "Johnson, Kayla M." --hearing-from 2025-01-01 --hearing-to 2025-01-31 --county Hennepin
```

Unknown counties, categories, and statuses fail instead of being silently ignored.

### Download one case

```bash
node cli.js download-case 27-CV-24-1 --out ./data/cases
```

Output goes to `./data/cases/27-CV-24-1/`.

### Bulk download

```bash
node cli.js bulk-download --file cases.txt --workers 2 --out ./data/cases
node cli.js bulk-download --cases 27-CV-24-1,62-CV-24-2
node cli.js bulk-download --file cases.txt --workers 2 --mode standalone --proxies proxies.txt
```

Text files use one case number per line; blank lines and lines beginning with `#` are ignored. JSON input must be an array. Duplicate case numbers are removed before queueing.

### Synchronize tracked cases

```bash
node cli.js sync --out ./data/cases
node cli.js sync --case 27-CV-24-1 --out ./data/cases
```

Sync revisits the docket and verifies every manifest-listed file. It does not rely only on the previous document count, so same-count docket changes and local corruption are not silently treated as current. Records marked active/open, plus legacy records without a status, are included in full syncs.

### Statewide discovery

```bash
node cli.js statewide --days 1 --out ./data/cases
node cli.js statewide --county Hennepin,Ramsey --category CV,CR --days 7 --out ./data/cases
```

The crawler partitions by county and category, then bisects capped date ranges. If a single county/category/day still reaches the cap, the command exits nonzero and identifies the incomplete partition. This is an integrity guard, not a guarantee that MCRO exposes every case or document.

### Continuous sync

```bash
node cli.js daemon --interval 24 --mode extension --out ./data/cases
```

The daemon waits the full configured interval. `SIGINT` and `SIGTERM` interrupt the wait and close the browser. Use a process supervisor for restart policy and logs.

### Verify PDFs

```bash
node cli.js verify ./data/cases
```

Checks minimum size, `%PDF` header, and a trailing `%%EOF` marker. Download manifests additionally enforce the previously recorded SHA-256 hash.

### OCR and deterministic preprocessing

```bash
node cli.js ocr ./data/cases/27-CV-24-1
node cli.js ocr ./data/cases
```

For every PDF, the pipeline writes:

- `<document>.txt` — extracted text with page separators
- `<document>.dossier.json` — provenance, page extraction sources, warnings, deterministic document classification/entities/anatomy, and bounded chunks
- `case_dossier.json` — case metadata, parties, filing index, procedural timeline, and merged deterministic headings/entities

The dossier summary fields are extractive previews, not LLM-generated legal conclusions. Regex-derived entities can contain false positives or omissions and must retain links to the source PDF/text.

### Other commands

```bash
node cli.js status
node cli.js counties
node cli.js proxy-test proxies.txt
```

## Durable output model

Default locations:

- Cases: `~/mncourt-data/cases/<case-number>/`
- State: `~/mncourt-data/state.json`
- Standalone session: `~/.mcro-puller/session.json`

Override cases and state independently:

```bash
export MCRO_OUTPUT_DIR=/persistent/mcro/cases
export MCRO_STATE_FILE=/persistent/mcro/state.json
```

Per-case layout:

```text
27-CV-24-1/
├── docket-export-index.json
├── README.txt
├── MCRO_27-CV-24-1_<document-key>_<source-name>.pdf
├── MCRO_...txt
├── MCRO_...dossier.json
└── case_dossier.json
```

`docket-export-index.json` is the authoritative downloaded-document inventory. Document keys distinguish repeated docket descriptions. Writes use temporary files plus atomic rename. `state.json` updates use both an in-process queue and an inter-process lock, and corrupt JSON fails closed instead of being replaced with an empty state.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `MCRO_OUTPUT_DIR` | `~/mncourt-data/cases` | Case directory root |
| `MCRO_STATE_FILE` | `~/mncourt-data/state.json` | Durable tracked-case state |
| `MCRO_MIN_DELAY_MS` | `8000` | Minimum cooperative request delay |
| `MCRO_MAX_DELAY_MS` | `20000` | Maximum cooperative request delay |
| `MCRO_PAGE_TIMEOUT_MS` | `30000` | Page navigation timeout |
| `MCRO_SEARCH_TIMEOUT_MS` | `45000` | Search timeout |
| `MCRO_DOWNLOAD_TIMEOUT_MS` | `30000` | PDF request timeout |
| `MCRO_MAX_RETRIES` | `3` | Per-document retry count |
| `MCRO_PROXIES` | unset | Optional comma/newline-separated proxy routes |

Invalid numeric values fail at startup.

## Failure semantics

Commands exit nonzero for material incompleteness, including:

- block/error pages or an unrecognized search result surface;
- a capped statewide slice that cannot be split further;
- any failed bulk worker, statewide case/partition, or full-sync case;
- corrupt state or manifest JSON;
- invalid/missing PDFs during verification;
- OCR or case-dossier failures.

Partial downloads remain on disk with their failure details in the case manifest. A later run verifies and resumes them.

## Cloud operation

Use persistent storage for both `MCRO_OUTPUT_DIR` and `MCRO_STATE_FILE`. Run one scheduler/daemon per logical workload, preserve browser/session affinity, retain logs, and alert on nonzero exits. Start with one worker and raise concurrency only when observed portal behavior and applicable terms permit it. A WAF/rate-limit response is a stop/backoff signal, not a reason to increase concurrency or rotate identities.

## Tests

```bash
pnpm test
pnpm run check
```

The suite covers concurrent state writers, atomic/provenance behavior, duplicate docket descriptions, PDF truncation, resumable manifests, capped partition bisection, search-page failure handling, OCR provenance, and NLP chunk boundaries.

## Known limits

- MCRO is an external UI, not a stable API. Selector or workflow changes require maintenance.
- Public availability, sealed/restricted documents, delayed indexing, and portal outages are outside this application's control.
- Search result cards are parsed from rendered text; changed labels can break extraction.
- A one-day partition can still exceed MCRO's result cap; the run fails rather than guessing.
- Deterministic NLP is preprocessing only. Human review or a separately governed model pipeline is required for legal interpretation.
