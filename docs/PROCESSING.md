# Document processing

`processDocument` returns data for parent persistence; it never writes dossier sidecars. Existing `preprocessPdf` retains sidecars for legacy callers. LLM inference is disabled unless an explicit `llm.enabled` config is passed. `llmConfigFromEnv()` is the opt-in environment parser; callers decide whether to use it.

## Layout and OCR choice

Poppler `pdftotext -layout` preserves visual spacing and page boundaries without introducing a heavyweight layout model or external inference. This is not table/reading-order reconstruction, bounding-box extraction, handwriting recognition, or a guarantee of multi-column semantic order. Sparse pages are rasterized individually by Poppler and recognized by Tesseract English. The longer of vector and OCR text is selected rather than concatenating duplicate text. Original PDF artifacts remain authoritative.

All OCR commands and pre-storage `pdfinfo` validators use `src/native-tools.js`, establishing resource limits before the native parser runs. Every invocation has a wall deadline of at most 60 seconds (download validation: 10 seconds; storage validation: 30 seconds), SIGKILL timeout, bounded captured output, one OpenMP thread, a 60-second CPU limit, and a per-output-file ceiling of at most 128 MiB (`ulimit -f 131072`; shells using 512-byte units enforce a stricter 64 MiB ceiling). Linux additionally enforces a 1 GiB address-space limit with `ulimit -v 1048576`. **No native RAM limit is claimed on macOS:** the observed platform rejects finite `ulimit -d` with EINVAL. Production containers must enforce aggregate memory/CPU limits. Failure to establish a limit stops execution, rather than running the parser unbounded. Raster longest side is capped at 2400 pixels; processing input is capped at 100 MiB and 2000 pages. Native extraction is synchronous and should execute in a worker, not an API request handler.

A successfully rendered all-white grayscale page plus successful empty OCR is `blank`. Visible content without recognized text is `unreadable`, not blank. Tool errors remain errors with page warnings; usable sparse text can survive a failed OCR attempt, but the run is partial. Invalid PDF/metadata or whole-document extraction failures throw. Neither unreadable pages nor tool failures count as successful blanks.

Offsets are zero-based JavaScript UTF-16 code-unit offsets into each exact returned page string; end offsets are exclusive. Chunks never cross pages. Deterministic entity mentions include literal evidence, heuristic confidence, and `verifiedAuthority: false`; citation strings are never represented as checked authorities. Classification prioritizes heading lines over filename hints. Confidence is a heuristic, not a calibrated probability.

Classification includes a parent `family` and specific `label`. Pleading subtypes include Complaint/Answer; notice subtypes include Summons and filing/deficiency notices; affidavit subtypes include service affidavits. Motion, Response, Declaration, Exhibit, Order, Judgment, Transcript, Correspondence, Administrative and Other families remain distinct. Uppercase/title-case heading candidates must not end in caption prose punctuation; a wrapped `complaint herein,` line cannot outrank `SUMMONS`. Source filename title segments are weaker fallback evidence. Pipeline `poppler-tesseract-4`, schema `3`, versions this correction rather than overwriting prior extraction results.


Labeled/contextual patterns additionally detect people, organizations, judges, attorneys, courts, addresses, and procedural events. Examples are `Plaintiff: Jane Doe`, `Judge: Susan Smith`, `Organization: Example LLC`, and `Hearing: 2025-05-20`. These are conservative English/Latin-name patterns, not comprehensive multilingual NER, identity resolution, role verification, address validation, or proof an event occurred. Their `labeled_context_pattern` provenance includes the literal context and `comprehensiveNer: false`; unrelated prose is not automatically treated as a person or organization.

## Optional interpretation

Set `COURT_LLM_ENABLED=true`, `COURT_LLM_PROVIDER=vertex|openai`, and `COURT_LLM_MODEL` only when external processing is authorized. Vertex uses `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and application default credentials. OpenAI-compatible requests require `COURT_LLM_ENDPOINT` (the full chat-completions URL) and `COURT_LLM_API_KEY`. HTTPS is required except loopback. No credentials are persisted in results.

The prompt marks document text as untrusted data and supplies no tools. Strict schema output distinguishes `allegation`, `requested_relief`, `procedural_statement`, `disposition`, `judicial_finding`, `testimony`, `representation`, `claim`, `evidence_reference`, `legal_citation`, `relationship`, and `contradiction`. Every assertion requires evidence. Quotes are revalidated against the original page string AND the actual spans supplied in that request. Unknown fields, invented quotes, unsupported kinds, HTTP errors, refusals, and invalid JSON fail explicitly without synthetic fallback. Exact quote validation does not prove that a paraphrase follows from the quote: persisted assertions retain `verifiedFact: false` and `entailmentVerified: false`.

A `legal_citation` assertion's text must consist solely of a supported literal statute, rule, or reporter citation present in its evidence quote. Supplying a valid neighboring quote cannot authorize an invented citation. This conservative recognizer does not cover every jurisdiction or citation syntax. Citation assertions are model observations of source text, never checked authority; they do not create or promote deterministic citation entities.

### Batching and budgets

Long filings are processed in serial batches of page spans, not truncated at 200000 characters. Each span carries the original page number and full-page UTF-16 start/end offsets. Evidence must remain inside a submitted span. All source text is covered once (no duplicate overlap); a finding or relationship spanning separate batches may therefore be missed. The pipeline does not claim exhaustive cross-document or cross-batch contradiction analysis.

All batches and reservations are planned before the first request. Defaults and environment overrides:

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `COURT_LLM_BATCH_CHARACTERS` | 40000 | Maximum serialized page-span payload characters per request (1024–100000) |
| `COURT_LLM_MAX_PAGES` | 2000 | Maximum source pages, including blanks |
| `COURT_LLM_MAX_REQUESTS` | 100 | Maximum requests per document |
| `COURT_LLM_MAX_INPUT_CHARACTERS` | 2000000 | Maximum original document UTF-16 characters |
| `COURT_LLM_MAX_OUTPUT_TOKENS` | 2048 | Provider-requested maximum output tokens per batch |
| `COURT_LLM_MAX_TOTAL_OUTPUT_TOKENS` | 65536 | Reserved output-token budget across every batch |
| `COURT_LLM_MAX_COST_USD` | unset | Optional estimated dollar reservation ceiling |
| `COURT_LLM_INPUT_USD_PER_MILLION_TOKENS` | unset | Operator-supplied current input pricing; required for dollar reservation |
| `COURT_LLM_OUTPUT_USD_PER_MILLION_TOKENS` | unset | Operator-supplied current output pricing; required for dollar reservation |

The dollar reservation assumes one input token per UTF-8 byte plus an 8192-byte per-request overhead reserve and the complete schema/system prompt, with the full requested output-token allowance. This intentionally conservative estimate is **not a provider billing guarantee**: model tokenizers, reasoning charges, prices, and compatible endpoints vary. Enforce cloud/provider quotas for a hard billing boundary. No current token prices are invented or hard-coded. Provider output-token caps are sent explicitly; a compatible endpoint must honor them. Exceeding any configured budget rejects the inference before a request, rather than silently processing only part of a filing. Requests are not retried automatically. A later request failure remains explicit; earlier requests may already have incurred charges.

## Regression and benchmark procedure

Parent integration runs `node --test test/nlp.test.js test/ocr.test.js` and both TypeScript processing test files with the repository TS runner. The expanded tests include long-document batching, exact offsets, conservative labeled entities, citation fabrication rejection, preflight budgets, and a controlled loopback API fixture. Native-tool fixture tests explicitly skip when binaries are absent; those skips are not OCR verification. No live cloud or model success is claimed.

For a representative, authorized corpus, measure wall time and peak RSS per document with OS resource tooling around the processing worker; record PDF hash, page count, native/scanned/blank mix, tool versions, raster settings, extraction method counts, unreadable/failure counts, and text precision/recall against human-transcribed pages. Compare layout/reading-order errors separately from OCR character error rate. Compare LLM schema rejection and invalid-evidence rates against a labeled sample with inference explicitly enabled; retain model/prompt versions and token/cost evidence. No benchmark measurements have been fabricated.

Legacy case synthesis includes only PDF filenames in the current docket manifest, excluding removed/failed entries. Unreferenced old dossier files are not discovered by directory enumeration.

## Optional bounded case interpretation

The integrated case module requires **both** `COURT_CASE_INTERPRETATION_ENABLED=true` and `COURT_LLM_ENABLED=true`, with approved provider/model configuration. It submits one bounded full-context request for current available document versions and latest completed extractions; oversized cases fail before inference instead of silently truncating context. The configured batch-character limit (default 40000, maximum 100000) also bounds this request. This optional module is not required for Minnesota local release.

Normalized runs/inputs/assertions/evidence retain model, provider, prompt/schema version, exact document-version/extraction IDs, page and UTF-16 spans. Every relationship/contradiction requires cross-document evidence. Quotes and recognized citations are validated, but entailment and legal truth are not established. Reads fail closed when the input set changes or is restricted. Durable job results retain only the run ID, not cached assertion content. Controlled loopback-provider tests exercised these contracts; no paid provider call was made.

Original-corpus versioned reprocessing on 2026-11-14: nine PDFs, 35 pages, pipeline `poppler-tesseract-4`, schema `3`; all nine current runs complete, including 16 Tesseract pages, 18 native text pages and one sparse native page. The original Summons now classifies as SUMMONS/NOTICE rather than COMPLAINT. Previous extraction runs remain retained. Three classifications use weaker filename evidence; these confidence scores are heuristic, not measured probabilities. No OCR accuracy/NER recall claim follows from successful processing.

