# Security and threat model

## Assets and trust boundaries

Protect original PDFs and their hashes, restricted case metadata, names/DOBs, extracted text, provenance and observations, queue state, database/LLM credentials, API tokens and audit history. Public source availability does not imply unrestricted redistribution, retention or inference rights. A user's local CLI/MCP process has database-level access and is more trusted than a remote HTTP caller.

Boundaries: untrusted court HTML/PDF → browser/download parser → immutable artifact storage → bounded native PDF/OCR processes → deterministic extraction/optional external model → PostgreSQL → authorized API consumers. The independent source fixture is synthetic portability evidence, not a claim of nationwide/live-source coverage. Model output and retrieved text are untrusted data, never instructions or authorization.

## Threats and controls

| Threat | Control and remaining exposure |
| --- | --- |
| Stolen/mis-scoped API bearer | Distinct read/write/admin tokens and endpoint authorization; Cloud Run additionally requires explicit IAM invoker. Tokens are bearer credentials, not per-user identities: provision narrow consumers, rotate, and retain audit attribution. Rate limits are not authentication. |
| Accidental public archive | GCS public-access prevention and uniform bucket IAM; private SQL with no public IPv4; no public browser VM IP or inbound rules. Cloud Run is internet-addressable but IAM authenticated. Never create public signed URLs or public bucket grants casually. |
| Runtime escalation | Dedicated API and worker service accounts; resource-scoped secret access; API bucket read, worker object create/get (no overwrite/delete); SQL roles separate from schema owner; nonroot/read-only container, dropped capabilities and bounded memory/PIDs. No project editor/owner runtime role or key files. |
| Dangerous PDF/HTML/native parser | Native parsers and Chromium process attacker-controlled input. Use bounded size/time/page processing, OS updates and container limits. Containers are not perfect isolation: a compromised worker can use its attached identity and allowed HTTPS egress. Do not place unrelated sensitive workloads on the browser VM. |
| SSRF/exfiltration | Adapter-controlled source URLs and source-specific policy; no arbitrary user-supplied URL ingestion. Browser VM egress allows HTTPS plus private SQL proxy. HTTPS is not a host allowlist: malicious parsers/worker compromise may exfiltrate to an arbitrary TLS host. A vetted egress proxy/private service perimeter is a production-hardening decision, not a claimed deployed control. Metadata service access is needed for attached IAM; do not treat the container boundary as identity isolation. |
| Supply-chain/secret leakage in image | Immutable base digest, lockfile, dated apt snapshot, Playwright version tied to lockfile, deny-default context with three named synthetic fixture exceptions. Build only reviewed source. Update pins for vulnerabilities; reproducibility does not confer security. Package install scripts are limited by pnpm workspace approval. |
| Cloud state/log secrets | Terraform creates secret metadata only and references secret IDs. Payloads are populated separately. State still exposes topology/principal names and must be encrypted/access-controlled. Do not log HTTP authorization, cookies, database URLs, OCR text or sensitive prompt/response content. |
| Job races/duplicate delivery | PostgreSQL leases, tokens, attempt records and idempotency. Content addressing prevents accidental byte changes under the same hash. Never promise at-most-once browser actions or infer no execution from an expired lease. |
| Wrong-document association/incomplete discovery | Require stable source identity/provenance, complete snapshots before destructive conclusions, and explicit partial/unknown coverage. A docket ordinal or filename is not a trustworthy document identity. |
| Prompt injection/model hallucination | External inference requires explicit configuration. Send only approved data to an approved provider/region. Model text cannot trigger tools, mutate access policy or rewrite evidence. Validate structured output and cited spans against deterministic text; model assertions remain distinct from source facts. |
| Sealed/restricted record leak | Authorize reads against current restriction status, audit changes, and apply restrictions across text/doc/API views. Retained raw objects/backups require an explicit access/retention procedure. Runtime worker has no physical-delete IAM permission; a separately controlled custodian handles approved deletion, including versions and backups. |
| Portal abuse | Live access off by default. Respect shared source budgets and challenge stops. No CAPTCHA bypass, stealth identity cycling, rotating proxies or invented authorization. Cloud NAT is ordinary networking, not an evasion mechanism. |

## Runtime privilege map

- **API service account:** `roles/cloudsql.client` project permission (Cloud SQL connection authorization, not SQL data privileges), GCS object viewer on the single artifact bucket, access only to its DB URL and three API token secrets. No object create/delete, secret mutation or provisioning permissions.
- **Worker service account:** Cloud SQL client, create/get-only custom role on artifact bucket, access to its DB URL secret, reader on the single Artifact Registry repository. No API token secrets or GCS delete/list/admin rights. The broad OAuth scope on the VM does not grant broad IAM permissions; attached roles are the actual authorization boundary.
- **Database API role:** SELECT plus explicit queue/discovery/source/audit mutations and restriction updates; no schema DDL. **Worker role:** data DML, excluding migration ledger writes; no database creation/role management. Review the grants whenever a service method/table is added. The local Compose owner role is not a production template.
- **Migration/deployment operators:** separate short-lived identities and approved change process, not runtime credentials. No deployment credential is installed by CI. The Cloud Run service agent may need repository read access for cross-project images; the supplied contract expects same-project regional Artifact Registry.

## Incident procedure

Pause the affected source/worker or revoke the compromised invoker, preserve sanitized logs, job attempts and image/config digests, then rotate the relevant secret and roll processes. Determine whether source records, raw PDFs, derived text, backups or model-provider logs were disclosed. Avoid deleting evidence or overwriting immutable migration hashes. Notify the responsible data/security owner under the applicable incident policy; do not claim legal retention/disclosure obligations without separate legal review. Re-enable only after an authenticated fixture check and explicit incident-owner approval.

## Unverified production requirements

No live cloud deployment, penetration test, browser sandbox certification, vulnerability scan, cloud backup/PITR restore, WAF interaction or LLM data-processing compliance was performed. A small isolated local PostgreSQL restore and artifact-reference verification did pass; see MINNESOTA_ACCEPTANCE. Production approval still requires relevant security/restore checks, defined retention/access policy, reviewed integrated-module runtime SQL grants, patch cadence, monitoring/on-call ownership, budget controls and source authorization. The Terraform default-off flag is an operational guard, not a security boundary against a principal already authorized to edit/apply it.
