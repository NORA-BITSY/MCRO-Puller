# MCRO-Puller

Autonomous, WAF-safe document discovery, bulk PDF extraction, and legal NLP/NER intelligence engine for **Minnesota Court Records Online (MCRO)** (`publicaccess.courts.state.mn.us`).

---

## Architecture & System Overview

`MCRO-Puller` is built for continuous, large-scale court record synchronization across all 87 Minnesota counties. It solves the core challenges of scraping public court portals:

1. **WAF & Bot Immunity (F5 Distributed Cloud / Volterra ADC & F5 BIG-IP ASM)**:
   - **Extension Mode (Default)**: Leverages your local running Chrome profile via Playwriter / CDP. Operates with genuine human TLS profiles, active session cookies (`mcro-session`, `TS01...`, `IsAcceptedTerms`), hardware graphics acceleration, and residential/mobile network signatures. **0% CAPTCHA/WAF rejection rate.**
   - **Standalone Mode + Proxy Pool**: For cloud resources (AWS, GCP, VPS), provides a multi-worker crawler backed by `playwright-extra` + stealth, rotating residential/mobile proxies, per-worker isolated cookie jars, and automatic circuit breakers.
2. **Statewide Discovery without Result Truncation**:
   - MCRO truncates any broad search to 200 cases.
   - `MCRO-Puller`'s partitioner divides statewide searches into orthogonal slices: **County (87 counties) $\times$ Category (Civil, Criminal, Family, Probate) $\times$ Date Window**. Every active case in Minnesota is discoverable without hitting the 200-case cap.
3. **Daily Incremental Delta Sync**:
   - Compares docket event counts against recorded state.
   - Skips unchanged dockets in ~2 seconds with zero document downloads.
   - Automatically detects newly filed docket rows and only pulls the new PDFs.
4. **Hybrid Vector & Tesseract OCR Pipeline**:
   - Born-digital PDFs (Civil Cover Sheets, Court Notices, Word-exported pleadings) have their vector text extracted instantly.
   - Scanned raster image filings (e.g. 400 DPI CCITT fax scans of complaints, exhibits, deeds) are rendered via `pdftoppm` and OCR'd using Apple Silicon-optimized Tesseract 5.5.
5. **Comprehensive Legal NLP & NER Data Model**:
   - **Document Dossier (`<doc>.dossier.json`)**: Legal anatomy (Caption, Claims/Counts, Factual Allegations, Prayer for Relief, Signatures/Bar Numbers), Named Entities (Statutes, Rules, Organizations, Parcels, Critical Dates, Monetary Damages), and structurally partitioned LLM context chunks with metadata headers.
   - **Case Dossier (`case_dossier.json`)**: Case-level synthesis with full party/attorney roster, procedural timeline, cross-document relationship graph, financial ledger, and executive brief.

---

## Installation

```bash
git clone <repo-url> MCRO-Puller
cd MCRO-Puller
pnpm install
```

Prerequisites for OCR:
- Tesseract OCR: `brew install tesseract` (Pre-installed on macOS)
- Poppler: `brew install poppler` (Provides `pdftotext` and `pdftoppm`)

---

## CLI Reference

### 1. Universal Search (All UI Fields)
Search across any and all MCRO search view fields:

```bash
# Search by Case Number or Citation
node cli.js search --case 67-CV-26-300
node cli.js search --citation 882606190625

# Search by Person Name with filters
node cli.js search --name "Anderson" --first "John" --county "Rock" --category "CV" --status "Active"

# Search by Business Name
node cli.js search --business "Hawthorne"

# Search by Attorney Name or MN Bar/License Number
node cli.js search --attorney "Vis"
node cli.js search --bar "0392011"

# Search Hearings by Judicial Officer & Date Range
node cli.js search --judge "Johnson, Kayla M." --hearing-from "2026-11-01" --hearing-to "2026-11-30"
```

### 2. Single Case Download
```bash
node cli.js download-case 67-CV-26-300 --out ./downloads
```

### 3. Bulk Downloads
Download dozens or thousands of cases from a file:

```bash
# From a text file (one case number per line)
node cli.js bulk-download --file cases.txt --workers 3

# With residential proxies for cloud runs
node cli.js bulk-download --file cases.txt --workers 5 --proxies proxies.txt --mode standalone
```

### 4. Incremental Daily Sync
Keep previously downloaded cases continuously updated:

```bash
# Sync all active cases in state.json (only downloads newly filed documents)
node cli.js sync

# Sync a single specific case
node cli.js sync --case 67-CV-26-300
```

### 5. Statewide Continuous Discovery
Partition across Minnesota's 87 counties to pull all active cases:

```bash
# Pull active cases filed in the past 24 hours across all counties
node cli.js statewide --days 1

# Pull active civil cases in specific counties
node cli.js statewide --county "Hennepin,Ramsey,Rock" --category "CV" --days 7
```

### 6. Continuous 24/7 Daemon Service
Run in the background to automatically sync active cases every 24 hours:

```bash
node cli.js daemon --interval 24 --out ./downloads
```

### 7. Hybrid OCR & NLP Preprocessing Pipeline
Extract full text, parse legal entities, and build LLM chunks:

```bash
# Process all PDFs in a case directory
node cli.js ocr ./downloads/67-CV-26-300
```

Generates:
- `*.pdf`: Original verified court document (%PDF magic bytes guaranteed).
- `*.txt`: Full clean text (hybrid vector + Tesseract OCR).
- `*.dossier.json`: Filing-level anatomy, NER entities, and pre-computed LLM chunks.
- `case_dossier.json`: Master synthesized case brief and procedural timeline.

### 8. Verification & Auditing
```bash
# Audit downloaded files to guarantee 0% corrupted stubs
node cli.js verify ./downloads

# Show summary of all tracked cases
node cli.js status

# List all 87 Minnesota counties and codes
node cli.js counties
```

---

## Data Model Structure

### Document Dossier (`<doc>.dossier.json`)
```json
{
  "schemaVersion": "1.0.0",
  "filingMeta": {
    "caseNumber": "67-CV-26-300",
    "filename": "MCRO_67-CV-26-300_Complaint-Civil_2026-11-03.pdf",
    "totalPages": 16,
    "documentType": "COMPLAINT"
  },
  "documentAnatomy": {
    "caption": {
      "caseNumber": "67-CV-26-300",
      "county": "Rock",
      "judicialDistrict": "FIFTH"
    },
    "causesOfAction": [
      {
        "countNumber": "COUNT I",
        "title": "Quiet Title / Adverse Possession",
        "allegationSnippet": "..."
      }
    ],
    "prayerForRelief": ["..."],
    "signatures": [
      {
        "signer": "Paul Alan Vis",
        "firm": "Vis & Linder Law Offices",
        "barNumber": "0392011"
      }
    ]
  },
  "nerAnalysis": {
    "statutesAndRules": ["Minn. Stat. § 541.02"],
    "organizations": ["Anderson Family Revocable Living Trust", "Illinois Central Gulf Railroad Company"],
    "locationsAndParcels": ["Section 30, Township 101 North, Range 46 West"],
    "criticalDates": ["September 1, 2015", "December 27, 2012"],
    "monetaryAmounts": ["$320.00"]
  },
  "llmContext": {
    "executiveSummary": "[COMPLAINT] Action to determine adverse claims...",
    "chunks": [
      {
        "chunkId": "67-CV-26-300-chunk-1",
        "index": 1,
        "text": "[DOCUMENT: COMPLAINT | CASE: 67-CV-26-300]\n\n...",
        "tokenEstimate": 457,
        "metadata": { "caseNumber": "67-CV-26-300", "documentType": "COMPLAINT" }
      }
    ]
  }
}
```

---

## Production Cloud Deployment (GCP / AWS / Docker)

When running on cloud datacenter IPs:
1. Supply a list of residential or mobile proxies via `proxies.txt` (`http://user:pass@host:port`).
2. Run `node cli.js proxy-test proxies.txt` to verify latency and Volterra WAF pass status.
3. Start workers using standalone mode:
   ```bash
   node cli.js bulk-download --file cases.txt --workers 5 --proxies proxies.txt --mode standalone
   ```
4. Each worker automatically instantiates its own isolated browser context and cookie jar to avoid session-IP mismatch flags on F5 BIG-IP.
