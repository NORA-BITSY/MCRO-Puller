import type { Pool, PoolClient } from 'pg';
import { transaction } from './database.js';
import type { CaseObservation, DocketEntry } from './contracts.js';
import { SourceError } from './contracts.js';
import { sha256 } from './storage.js';

export function canonicalJson(value: unknown): string {
  function sort(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
    }
    return item;
  }
  return JSON.stringify(sort(value));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function explicitKey(value: unknown): string | undefined {
  const item = record(value);
  return text(item['id'], item['sourceKey'], item['sourceId']);
}

/** Partial observations add knowledge; absence is not evidence of removal. */
function mergePartial(previous: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return previous;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    const merged = [...previous];
    const positions = new Map(previous.map((item, index) => [explicitKey(item) ? `id:${explicitKey(item)}` : `raw:${canonicalJson(item)}`, index]));
    for (const item of incoming) {
      const key = explicitKey(item) ? `id:${explicitKey(item)}` : `raw:${canonicalJson(item)}`;
      const position = positions.get(key);
      if (position === undefined) {
        positions.set(key, merged.length);
        merged.push(item);
      } else merged[position] = mergePartial(merged[position], item);
    }
    return merged;
  }
  if (previous !== null && typeof previous === 'object' && !Array.isArray(previous) && incoming !== null && typeof incoming === 'object' && !Array.isArray(incoming)) {
    const before = record(previous);
    const after = record(incoming);
    return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map((key) => [key, mergePartial(before[key], after[key])]));
  }
  return incoming;
}

function filedDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(raw);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  const year = Number(iso?.[1] ?? us?.[3]);
  const month = Number(iso?.[2] ?? us?.[1]);
  const day = Number(iso?.[3] ?? us?.[2]);
  if (!iso && !us) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function caseMetadata(observation: CaseObservation, previous: Record<string, unknown>): Record<string, unknown> {
  const top = record(observation);
  const raw = observation.raw;
  const info = record(raw['caseInfo']);
  const county = text(top['county'], raw['county'], info['county'], raw['region'], info['caseLocation']);
  const category = text(top['category'], raw['category'], raw['caseType'], info['category'], info['caseType']);
  const date = filedDate(text(top['filedDate'], top['dateFiled'], raw['filedDate'], raw['dateFiled'], raw['filedOn'], info['filedDate'], info['dateFiled']));
  return {
    ...previous,
    sections: observation.complete ? observation.sections : mergePartial(previous['sections'], observation.sections),
    raw: observation.complete ? raw : mergePartial(previous['raw'], raw),
    ...(county ? { county } : {}), ...(category ? { category } : {}), ...(date ? { filedDate: date } : {}),
  };
}

function entryData(entry: DocketEntry): Record<string, unknown> {
  return { sourceId: entry.sourceId ?? null, date: entry.date, title: entry.title,
    documents: entry.documents, raw: entry.raw, identityConfidence: entry.identityConfidence };
}

function semanticRaw(value: unknown, eventRoot = false): unknown {
  if (Array.isArray(value)) return value.map((item) => semanticRaw(item));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['sourceOrder', 'formIndex', 'btnSelector', 'downloadToken', 'requestVerificationToken'].includes(key)
      && !(eventRoot && ['index', 'document', 'documents'].includes(key)))
    .map(([key, child]) => [key, semanticRaw(child)]));
}

function semanticEntry(entry: DocketEntry): Record<string, unknown> {
  return { sourceId: entry.sourceId ?? null, date: entry.date, title: entry.title,
    documents: [...entry.documents].sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId)).map((document) => ({ ...document, raw: semanticRaw(document.raw) })),
    raw: semanticRaw(entry.raw, true), identityConfidence: entry.identityConfidence };
}

function validateObservation(observation: CaseObservation): void {
  if (!observation.sourceId || !observation.sourceCaseId || !observation.caseNumber || !Number.isFinite(Date.parse(observation.observedAt))) {
    throw new SourceError('parse_error', 'Observation lacks case identity or timestamp');
  }
  const entryKeys = new Set<string>();
  const documentKeys = new Set<string>();
  for (const entry of observation.entries) {
    if (!entry.identityKey || entryKeys.has(entry.identityKey)) throw new SourceError('parse_error', 'Ambiguous duplicate entry identities; observation not merged');
    if (!Number.isSafeInteger(entry.sourceOrder) || entry.sourceOrder < 0) throw new SourceError('parse_error', 'Invalid entry source order');
    entryKeys.add(entry.identityKey);
    for (const document of entry.documents) {
      if (!document.sourceDocumentId || documentKeys.has(document.sourceDocumentId)) throw new SourceError('parse_error', 'Ambiguous duplicate document identity collision; observation not merged');
      if (document.entryKey !== entry.identityKey || document.caseNumber !== observation.caseNumber) throw new SourceError('parse_error', 'Document reference does not match its case and entry');
      documentKeys.add(document.sourceDocumentId);
    }
  }
}

async function change(client: PoolClient, caseId: string, snapshotId: string, entryId: string | null, kind: string, before: unknown, after: unknown): Promise<void> {
  await client.query('INSERT INTO entry_changes(case_id,snapshot_id,entry_id,kind,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)',
    [caseId, snapshotId, entryId, kind, JSON.stringify(before), JSON.stringify(after)]);
}

async function reconcileParticipants(client: PoolClient, caseId: string, observation: CaseObservation): Promise<void> {
  const existing = await client.query<{ id: string; source_key: string; raw: Record<string, unknown> }>('SELECT id,source_key,raw FROM participants WHERE case_id=$1', [caseId]);
  const byKey = new Map(existing.rows.map((row) => [explicitKey(row.raw) ?? row.source_key, row]));
  if (observation.complete) await client.query('DELETE FROM participants WHERE case_id=$1', [caseId]);
  for (const participant of observation.participants) {
    const sourceKey = explicitKey(participant) ?? sha256(canonicalJson(participant));
    const previous = observation.complete ? undefined : byKey.get(sourceKey);
    const data = previous ? record(mergePartial(previous.raw, participant)) : participant;
    const values = [caseId, sourceKey, text(data['kind']) ?? 'unknown', text(data['name'], data['text']) ?? '', text(data['role']) ?? '', JSON.stringify(data)];
    if (previous) {
      await client.query('UPDATE participants SET source_key=$2,kind=$3,name=$4,role=$5,raw=$6 WHERE case_id=$1 AND id=$7', [...values, previous.id]);
    } else {
      await client.query(`INSERT INTO participants(case_id,source_key,kind,name,role,raw) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(case_id,source_key) DO UPDATE SET kind=EXCLUDED.kind,name=EXCLUDED.name,role=EXCLUDED.role,raw=EXCLUDED.raw`, values);
    }
  }
}

async function reconcileProceedings(client: PoolClient, caseId: string, observation: CaseObservation, previousSections: unknown): Promise<void> {
  const existing = await client.query<{ id: string; kind: string; source_key: string; data: unknown }>('SELECT id,kind,source_key,data FROM proceedings WHERE case_id=$1', [caseId]);
  const previous = record(previousSections);
  const byKey = new Map(existing.rows.map((row) => {
    const sourceKey = explicitKey(row.data) ?? (Array.isArray(previous[row.kind]) ? sha256(canonicalJson(row.data)) : `section:${row.kind}`);
    return [canonicalJson([row.kind, sourceKey]), row];
  }));
  if (observation.complete) await client.query('DELETE FROM proceedings WHERE case_id=$1', [caseId]);
  for (const [kind, section] of Object.entries(observation.sections)) {
    const items = Array.isArray(section) ? section : [section];
    for (const item of items) {
      const sourceKey = explicitKey(item) ?? (Array.isArray(section) ? sha256(canonicalJson(item)) : `section:${kind}`);
      const before = observation.complete ? undefined : byKey.get(canonicalJson([kind, sourceKey]));
      const data = before ? mergePartial(before.data, item) : item;
      if (before) {
        await client.query('UPDATE proceedings SET source_key=$3,data=$4 WHERE case_id=$1 AND kind=$2 AND id=$5', [caseId, kind, sourceKey, JSON.stringify(data), before.id]);
      } else {
        await client.query('INSERT INTO proceedings(case_id,kind,source_key,data) VALUES($1,$2,$3,$4) ON CONFLICT(case_id,kind,source_key) DO UPDATE SET data=EXCLUDED.data',
          [caseId, kind, sourceKey, JSON.stringify(data)]);
      }
    }
  }
}

export async function reconcileObservation(pool: Pool, observation: CaseObservation, guard?: (client: PoolClient) => Promise<void>): Promise<{ caseId: string; snapshotId: string; documents: string[]; complete: boolean }> {
  validateObservation(observation);
  const observedAt = Date.parse(observation.observedAt);
  const snapshotHash = sha256(canonicalJson(observation));
  const observedDocumentKeys = observation.entries.flatMap((entry) => entry.documents.map((document) => document.sourceDocumentId));
  return transaction(pool, async (client) => {
    // Every transactional job writer acquires its job lease before case locks.
    if (guard) await guard(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [canonicalJson([observation.sourceId, observation.sourceCaseId])]);
    const existing = await client.query<{ id: string; title: string; court: string; status: string; availability: string; last_observed_at: Date | null; metadata: Record<string, unknown> }>(
      'SELECT id,title,court,status,availability,last_observed_at,metadata FROM cases WHERE source_id=$1 AND source_case_id=$2 FOR UPDATE', [observation.sourceId, observation.sourceCaseId]);
    const previous = existing.rows[0];
    if (previous && previous.availability !== 'public') throw new SourceError('restricted', 'Case restricted; explicit administrative review required');
    if (previous?.last_observed_at && previous.last_observed_at.getTime() > observedAt) throw new SourceError('permanent', 'Older observation cannot overwrite newer case state');
    const priorSnapshot = previous ? (await client.query<{ id: string }>('SELECT id FROM docket_snapshots WHERE case_id=$1 AND sha256=$2 AND observed_at=$3', [previous.id, snapshotHash, observation.observedAt])).rows[0] : undefined;
    if (previous?.last_observed_at?.getTime() === observedAt && !priorSnapshot) throw new SourceError('permanent', 'Conflicting observation at the same timestamp cannot overwrite case state');
    const identityMigrations = new Map<string, { documentId: string; entryId: string; entryKey: string; reference: unknown }>();
    if (previous && !priorSnapshot && observedDocumentKeys.length) {
      const existingReferences = await client.query<{ id: string; entry_id: string; source_document_id: string; identity_key: string; reference: unknown }>(
        `SELECT d.id,d.entry_id,d.source_document_id,d.reference,e.identity_key FROM documents d JOIN docket_entries e ON e.id=d.entry_id
         WHERE d.case_id=$1 AND d.source_document_id=ANY($2::text[])`, [previous.id, observedDocumentKeys]);
      const referenceEntries = new Map(observation.entries.flatMap((entry) => entry.documents.map((document) => [document.sourceDocumentId, entry.identityKey] as const)));
      for (const reference of existingReferences.rows) {
        if (referenceEntries.get(reference.source_document_id) === reference.identity_key) continue;
        const provenance = record(record(reference.reference)['raw']);
        if (provenance['legacy'] !== true || provenance['legacyFullManifest'] !== true || provenance['sourceIdentityVerified'] !== true) {
          throw new SourceError('parse_error', 'Document identity collision with another entry; observation not merged');
        }
        identityMigrations.set(reference.source_document_id, {
          documentId: reference.id, entryId: reference.entry_id, entryKey: reference.identity_key, reference: reference.reference,
        });
      }
    }
    // Recheck after advisory/row-lock waits; the lease may expire while waiting.
    // The first guard keeps lock ordering job -> case, matching administrative writes.
    if (guard) await guard(client);
    if (previous && priorSnapshot) {
      const documents = await client.query<{ id: string }>("SELECT id FROM documents WHERE case_id=$1 AND source_document_id=ANY($2::text[]) AND availability='available' AND (acquisition_status<>'complete' OR next_revalidation_at IS NULL OR next_revalidation_at<=now()) ORDER BY source_document_id", [previous.id, observedDocumentKeys]);
      return { caseId: previous.id, snapshotId: priorSnapshot.id, documents: documents.rows.map((document) => document.id), complete: observation.complete };
    }
    const metadata = caseMetadata(observation, previous?.metadata ?? {});
    const title = !observation.complete && !observation.title ? previous?.title ?? '' : observation.title;
    const court = !observation.complete && !observation.court ? previous?.court ?? '' : observation.court;
    const status = !observation.complete && !observation.status ? previous?.status ?? '' : observation.status;
    const result = await client.query<{ id: string }>(`INSERT INTO cases(source_id,source_case_id,case_number,title,court,status,metadata,last_observed_at,next_refresh_at,acquisition_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '1 day','partial')
      ON CONFLICT(source_id,source_case_id) DO UPDATE SET case_number=EXCLUDED.case_number,title=EXCLUDED.title,court=EXCLUDED.court,status=EXCLUDED.status,
      metadata=EXCLUDED.metadata,last_observed_at=EXCLUDED.last_observed_at,next_refresh_at=EXCLUDED.next_refresh_at,acquisition_status='partial',updated_at=now() RETURNING id`,
    [observation.sourceId, observation.sourceCaseId, observation.caseNumber, title, court, status, JSON.stringify(metadata), observation.observedAt]);
    const caseId = result.rows[0]!.id;
    if (!previous || previous.status !== status) await client.query('INSERT INTO case_status_history(case_id,status,observed_at) VALUES($1,$2,$3)', [caseId, status, observation.observedAt]);
    const snapshot = await client.query<{ id: string }>('INSERT INTO docket_snapshots(case_id,observed_at,complete,sha256,raw) VALUES($1,$2,$3,$4,$5) RETURNING id', [caseId, observation.observedAt, observation.complete, snapshotHash, JSON.stringify(observation)]);
    const snapshotId = snapshot.rows[0]!.id;
    const old = await client.query<{ id: string; identity_key: string; source_order: number; availability: string }>('SELECT id,identity_key,source_order,availability FROM docket_entries WHERE case_id=$1', [caseId]);
    const oldByKey = new Map(old.rows.map((row) => [row.identity_key, row]));
    const documentIds: string[] = [];
    for (const entry of observation.entries) {
      const before = oldByKey.get(entry.identityKey);
      const data = entryData(entry);
      const digest = sha256(canonicalJson(semanticEntry(entry)));
      const stored = await client.query<{ id: string }>(`INSERT INTO docket_entries(case_id,identity_key,source_id,source_order,event_date,title,identity_confidence,availability,raw,first_seen_at,last_seen_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'public',$8,$9,$9) ON CONFLICT(case_id,identity_key) DO UPDATE SET source_id=EXCLUDED.source_id,source_order=EXCLUDED.source_order,
        event_date=EXCLUDED.event_date,title=EXCLUDED.title,identity_confidence=EXCLUDED.identity_confidence,availability='public',raw=EXCLUDED.raw,last_seen_at=EXCLUDED.last_seen_at RETURNING id`,
      [caseId, entry.identityKey, entry.sourceId ?? null, entry.sourceOrder, entry.date, entry.title, entry.identityConfidence, JSON.stringify(entry.raw), observation.observedAt]);
      const entryId = stored.rows[0]!.id;
      const lastVersion = await client.query<{ sha256: string; data: unknown }>('SELECT sha256,data FROM entry_versions WHERE entry_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [entryId]);
      if (lastVersion.rows[0]?.sha256 !== digest) {
        await client.query('INSERT INTO entry_versions(entry_id,snapshot_id,sha256,data) VALUES($1,$2,$3,$4)', [entryId, snapshotId, digest, JSON.stringify(data)]);
        await change(client, caseId, snapshotId, entryId, before ? 'modified' : 'added', lastVersion.rows[0]?.data ?? null, data);
      }
      if (before && before.source_order !== entry.sourceOrder) await change(client, caseId, snapshotId, entryId, 'reordered', { order: before.source_order }, { order: entry.sourceOrder });
      if (before && before.availability !== 'public') await change(client, caseId, snapshotId, entryId, 'reappeared', { availability: before.availability }, { availability: 'public' });
      for (const document of entry.documents) {
        const documentStatus = document.availability === 'available' ? 'pending' : document.availability === 'restricted' ? 'restricted' : 'unavailable';
        const fingerprint=sha256(canonicalJson({title:document.title,pages:document.raw['pages']??null,revision:document.revision??null}));
        const saved = await client.query<{ id: string;availability:string;acquisition_status:string }>(`INSERT INTO documents(case_id,entry_id,source_document_id,title,reference,availability,acquisition_status,reference_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(case_id,source_document_id) DO UPDATE SET entry_id=EXCLUDED.entry_id,title=EXCLUDED.title,reference=EXCLUDED.reference,
          availability=EXCLUDED.availability,acquisition_status=CASE WHEN EXCLUDED.availability='available' AND documents.availability='available'
            AND documents.acquisition_status='complete' AND documents.current_version_id IS NOT NULL
            AND documents.reference_fingerprint=EXCLUDED.reference_fingerprint AND documents.next_revalidation_at>now()
            THEN 'complete' ELSE EXCLUDED.acquisition_status END,reference_fingerprint=EXCLUDED.reference_fingerprint,updated_at=now() RETURNING id,availability,acquisition_status`,
        [caseId, entryId, document.sourceDocumentId, document.title, JSON.stringify(document), document.availability, documentStatus,fingerprint]);
        const migration = identityMigrations.get(document.sourceDocumentId);
        if (migration) {
          await change(client, caseId, snapshotId, entryId, 'identity_migrated',
            { documentId: migration.documentId, sourceDocumentId: document.sourceDocumentId, entryId: migration.entryId, entryKey: migration.entryKey, reference: migration.reference },
            { documentId: saved.rows[0]!.id, sourceDocumentId: document.sourceDocumentId, entryId, entryKey: entry.identityKey });
        }
        if (saved.rows[0]!.availability === 'available'&&saved.rows[0]!.acquisition_status!=='complete') documentIds.push(saved.rows[0]!.id);
      }
    }
    if (observation.complete) {
      const observedKeys = new Set(observation.entries.map((entry) => entry.identityKey));
      for (const row of old.rows.filter((entry) => !observedKeys.has(entry.identity_key) && entry.availability === 'public')) {
        await client.query("UPDATE docket_entries SET availability='removed' WHERE id=$1", [row.id]);
        await change(client, caseId, snapshotId, row.id, 'removed', { availability: 'public' }, { availability: 'removed' });
      }
      await client.query("UPDATE documents SET availability='removed',acquisition_status='unavailable',updated_at=now() WHERE case_id=$1 AND NOT(source_document_id=ANY($2::text[]))", [caseId, observedDocumentKeys]);
    }
    await reconcileParticipants(client, caseId, observation);
    await reconcileProceedings(client, caseId, observation, previous?.metadata['sections']);
    await client.query(`UPDATE cases SET acquisition_status=CASE WHEN $2 AND NOT EXISTS(
      SELECT 1 FROM documents WHERE case_id=$1 AND availability='available' AND acquisition_status<>'complete') THEN 'complete' ELSE 'partial' END WHERE id=$1`, [caseId, observation.complete]);
    return { caseId, snapshotId, documents: documentIds, complete: observation.complete };
  });
}
