# Capacity, cost and empirical measurement

## Evidence boundary

The scaled rates below are **planning assumptions and arithmetic**, not observed portal throughput. No10k/100k/1m acquisition, live statewide completeness, cloud deployment or paid inference is asserted. The small local observations below measure only the tested workload; synthetic fixtures prove interface behavior, not another state's portal or nationwide coverage.

## Measured Minnesota-first workload

Checkpoint819b512 on macOS25.6 arm64/Node24.22.2; local container VM2CPU/4GiB, PostgreSQL17. Raw reports are ignored under `.runtime/` and summarized in MINNESOTA_ACCEPTANCE.

- Minnesota-shaped offline parser→jobs/PG→CLI/HTTP/MCP→refresh/restriction/crash-recovery acceptance:17.402seconds, two initial docket events/two documents, three events/three retained versions after change, zero browser network attempts. This includes process startup and fault handling, not a source throughput measurement.
- Original corpus:9PDFs/35pages;16Tesseract OCR,18native text,1sparse native page. Final processing completions span06:07:10.609–06:07:32.098Z; this21.489-second **completion span excludes time before the first completion**, so it is not full processing wall time or a rate estimate. Eleven copied objects including two synthetic PDFs occupy4,626,440bytes.
- Packaged acquisition: one synthetic case/three events/two documents, six jobs, native extraction and integrity reads;1.933seconds including CLI/container startup/read commands. No external court access.
- Authenticated local `/api/v1/cases?sourceId=independent-fixture`,30requests,concurrency2,one stored case:0failures,78.004ms total,p50 2.578ms,p95 21.418ms,p99/max38.534ms. Existing `infra/benchmark.mjs`, no warmup subtraction; VM was already running. The short sample is insufficient for a production SLA, saturation limit or million-case extrapolation.

Daily feasibility remains unknown until an authorized source route supplies actual request counts/latency, discovery population, change rates, permitted budgets and sustained failures. Additional workers cannot remove that source constraint. No large synthetic benchmark was required for this local release.

## Workload model

Let `N` be cases, `D` average documents/case, `P` pages/document, `B` MiB/document, `f` scanned-page fraction, `s_ocr` CPU seconds/scanned page, `s_text` CPU seconds/text page, `r` mean retries per operation, `W` processing cores and `u` effective utilization. Assume one docket operation plus `D` document operations per case and one serial source admission every `I` seconds.

- PDF storage GiB = `N × D × B / 1024`, before deduplication/versions/soft-delete.
- Page count = `N × D × P`.
- Processing CPU hours = `pages × (f × s_ocr + (1-f) × s_text) / 3600`; wall hours lower bound = CPU hours / `(W × u)`.
- Source admission days lower bound = `N × (1 + D) × (1+r) × I / 86400`. Browser navigation/document operations may require multiple HTTP requests: a job admission interval is **not** a per-HTTP-request guarantee. Include measured duration, pagination, search partitions, retries, downtime and challenges before estimating actual finish dates.
- End-to-end elapsed is bounded by the slowest of source admission/browser work, extraction CPU, database writes and network/storage; do not simply add ideal independent rates or assume CPU parallelism increases permitted portal traffic.
- Freshness workload per day = eligible cases / refresh interval days, plus newly observed cases/documents and periodic artifact revalidation. Routine unchanged observations skip verified files until `next_revalidation_at`; new files, reappearance, title/page-count changes and explicit source revision changes fetch immediately. Sources default to 168-hour artifact revalidation (database constraint: 1–720 hours). Hash deduplication happens **after** a fetched file, so periodic validation still consumes transfer, browser and storage-verification capacity. Same-ID replacements without a reliable revision signal may remain undetected until the next case observation after that deadline; inactive/closed-case observation intervals add further delay.

Illustration only: `D=20`, `P=4`, `B=0.5 MiB`, `I=15 s`, `r=0`, one source concurrency, no downtime:

| Cases | PDFs | Pages | PDF GiB | Minimum source-operation days | GCS live bytes/month at ~$0.02/GiB |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 200,000 | 800,000 | 97.66 | 36.46 | $1.95 |
| 100,000 | 2,000,000 | 8,000,000 | 976.56 | 364.58 | $19.53 |
| 1,000,000 | 20,000,000 | 80,000,000 | 9,765.63 | 3,645.83 | $195.31 |

The storage column is **not the total system cost**. Example OCR assumption `f=0.30`, `s_ocr=2`, `s_text=0.03`, `W=2`, `u=0.70` produces approximately 98.57 / 985.71 / 9,857.14 processing wall hours respectively. These are unmeasured hypothetical speeds, not benchmarks or SLAs. Replacing those inputs with measured medians alone misses long tails; include p95/p99, failed documents, retries and page-size distributions. Increasing workers must not increase a source's shared approved concurrency/interval. Partition discovery on documented dimensions, report saturated/truncated partitions and unknown denominators; do not equate observed count to complete coverage.

For steady-state planning add approximately `tracked available documents / revalidation interval days` fetches/day, plus changed/new documents and retries. This is an average, not load leveling: initial backfills can create synchronized revalidation deadlines. Source budgets serialize the resulting backlog rather than promising daily completion. Local regression observes three network-adapter acquisitions across four refreshes: first acquisition, zero for unchanged refresh, one for a revision change, one for expired revalidation; all three differing byte versions remain stored.

For one million cases under the illustrative document ratio, a 100 GiB SQL disk cannot be assumed sufficient: 20 million document/version rows plus 80 million pages/chunks, indexes, provenance, snapshots and attempts dominate metadata. Measure `pg_total_relation_size` for each relation and WAL growth; estimate `fixed + N × measured marginal bytes/case`, retaining headroom for indexes/vacuum/migrations and backup copies. The Terraform 500 GiB growth cap is a spend/control limit, not a million-case capacity promise.

## Current public unit prices

Retrieved 2026-11-13 from Google's public primary pricing pages, USD on-demand **us-central1**, no negotiated discounts, commitments, free-tier credits or tax. Recheck region/SKU/currency before purchase. Sources show hourly GiB rates; using 730 hours/month converts them approximately to familiar monthly rates.

| Component | Public rate used | Primary source |
| --- | --- | --- |
| Cloud Run request-based active CPU | $0.000024/vCPU-second | [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| Cloud Run active memory | $0.0000025/GiB-second | [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| Cloud Run requests | $0.40/million | [Cloud Run pricing](https://cloud.google.com/run/pricing) |
| Cloud SQL Enterprise general-purpose CPU/memory | $0.0413/vCPU-hour and $0.007/GiB-hour; HA $0.0826 and $0.014 | [Cloud SQL pricing](https://cloud.google.com/sql/pricing) |
| SQL SSD / HA SSD | $0.000232877 / $0.000465753 per GiB-hour (~$0.17 / $0.34 per GiB-month) | [Cloud SQL pricing](https://cloud.google.com/sql/pricing) |
| SQL used backups | $0.000109589/GiB-hour (~$0.08/GiB-month) | [Cloud SQL pricing](https://cloud.google.com/sql/pricing) |
| GCS regional Standard | $0.000027397/GiB-hour (~$0.02/GiB-month) | [Cloud Storage pricing](https://cloud.google.com/storage/pricing) |
| GCS Standard flat-namespace operations | Class A $0.005/1,000; Class B $0.0004/1,000 | [Cloud Storage pricing](https://cloud.google.com/storage/pricing) |
| e2-standard-2 (2 vCPU/8 GiB) | $0.06701142/hour (~$48.92/730h month) | [Compute general-purpose pricing](https://cloud.google.com/products/compute/pricing/general-purpose#e2-machine-types) |

Baseline **estimate**, corresponding to Terraform's regional HA SQL 2 vCPU/7.5 GiB and 100 GiB SSD plus one always-on browser VM:

- SQL compute: `730 × (2 × 0.0826 + 7.5 × 0.014) = $197.25/month`.
- SQL HA disk: `100 × 730 × 0.000465753 ≈ $34.00/month`.
- Browser VM compute: `730 × 0.06701142 ≈ $48.92/month`.
- Subtotal **$280.17/month before** API, PDFs, backups, VM disk, NAT, IPv4/NAT addresses, network egress, Artifact Registry, logging/monitoring, Secret Manager, build storage and any inference. Idle SQL and the VM still incur charges. Regional HA has a deliberate reliability premium; switching to zonal is a design/risk decision, not a hidden discount.

API cost formula before free tier = `billed vCPU-seconds × 0.000024 + billed GiB-seconds × 0.0000025 + requests / 1e6 × 0.40`. Bill instance resources, not request count × latency when requests overlap. For an explicitly hypothetical one million requests, 0.1 billed instance-second per request without overlap, 1 vCPU and 1 GiB: `$2.40 + $0.25 + $0.40 = $3.05`, not an observed API bill.

The supplied Cloud Run template reserves an additional 1 vCPU/128 MiB proxy sidecar, so its aggregate is 2 vCPU/1.125 GiB while active. Under the same hypothetical nonoverlapping 100,000 active seconds, that template would cost approximately `$4.80 + $0.28125 + $0.40 = $5.48`, before free tiers. Include both containers and startup time in actual billing inputs.

GCS ingest operation example: one Class A upload per unique PDF costs `$1 / $10 / $100` at 10k/100k/1m illustrative cases. Each full-document GET adds Class B charges; SDK existence checks, retries, metadata calls, verification reads and object versions alter this. Do not claim a deduplication discount without observing distinct hashes. Egress and NAT can exceed storage cost; use [network pricing](https://cloud.google.com/vpc/network-pricing) and the actual source/destination byte mix in the release estimate rather than treating omitted components as zero.

LLM cost is excluded, not free: `approved input tokens × model input unit price + output tokens × output unit price`, plus retries and provider minimums. Select/provider-price a model only after approved data governance and a measured token distribution; no default paid inference is needed for acquisition, native text or OCR. Budgets alert rather than enforce a hard cap; impose reviewed max instances, source budgets, worker count, database disk cap and inference opt-in as well.

## Reproducible empirical harness commands

Run against isolated local data only. Parent/release verification records observed outputs; the commands below are not claims they ran.

### Native processing and fixture integration

```sh
pnpm build
COURT_TEST_DATABASE_URL="$DISPOSABLE_DATABASE_URL" pnpm test
node --test infra/tests/*.test.mjs
node dist/src/platform/courtctl.js acquire \
  --query '{"sourceId":"independent-fixture","searchType":"case","caseNumber":"FX-2024-0001"}' \
  --idempotency-key capacity-fixture-001
```

Run the worker against the same disposable database/storage and inspect the returned job plus dependent document/processing jobs until terminal. Capture attempts, completed/partial/restricted counts and wall time. Reusing the idempotency key measures replay, not new ingestion. This fixture contains a valid two-attachment case; it is deliberately too small to predict live throughput. Use an approved representative PDF corpus to measure scanned/native pages separately, parser timeouts, quality and peak memory. `/usr/bin/time -l` on macOS or `/usr/bin/time -v` on Linux can wrap a representative processing/integration invocation; report what was timed, not just a number.

### Actual PostgreSQL 10k / 100k / 1m case-index experiment

Create/migrate a **disposable database ending `_benchmark`**. `infra/benchmark-corpus.sql` inserts synthetic case rows with real indexes inside a transaction, ANALYZEs, measures relation size and emits `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for exact identity and first-page queries, then rolls rows back. It refuses other database names. It does not populate the 20-documents/case scenario, run HTTP queries or measure portal/OCR throughput.

```sh
COURT_DATABASE_URL="$BENCH_DATABASE_URL" node dist/src/platform/courtctl.js db migrate
psql "$BENCH_DATABASE_URL" -v scale=10000 -f infra/benchmark-corpus.sql
psql "$BENCH_DATABASE_URL" -v scale=100000 -f infra/benchmark-corpus.sql
psql "$BENCH_DATABASE_URL" -v scale=1000000 -f infra/benchmark-corpus.sql
```

Use a fresh disposable database per scale/cold-cache sample; rollback can retain allocated pages and cache warmth. Record hardware/PG version/settings, wall and CPU time, rows, buffers, relation/index bytes and query plans. Drop only the explicitly identified disposable benchmark database afterward. Add representative docket/chunk/version distribution before making whole-platform storage estimates.

### Actual local HTTP latency

```sh
API_TOKEN_READ="$API_TOKEN_READ" BENCH_REQUESTS=1000 BENCH_CONCURRENCY=4 \
  node infra/benchmark.mjs
```

Default target is authenticated local `/api/v1/health`. Set `BENCH_URL` to a documented local API read URL to measure that query instead. Only loopback hosts are accepted; use a controlled tunnel for approved staging, not a portal URL. JSON output records elapsed time, requests/second, failure count and p50/p95/p99/max latency. Errors including 429 count as failures and produce a nonzero exit; do not turn off protective rate limits to inflate a headline. This is a finite closed-loop client with no warmup subtraction, so it is not a production arrival-rate/load model.

For every published result include revision/image/tool versions, hardware/resources, fixture vs approved real corpus, corpus counts/pages/bytes, cold/warm state, concurrency, source policy, failures/retries/partial counts, measurement command, output artifact and observation timestamp. Distinguish successful throughput from attempted throughput; retain measured distributions rather than extrapolating a single best run.
