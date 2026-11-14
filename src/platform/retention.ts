import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from './database.js';
import { SourceError } from './contracts.js';
import { JobConflictError } from './jobs.js';
import type { ArtifactStore } from './storage.js';

export const RetentionPolicySchema=z.strictObject({enabled:z.boolean(),artifactGcEnabled:z.boolean()});
export const RetentionRequestSchema=z.strictObject({caseId:z.uuid(),documentId:z.uuid().optional(),action:z.enum(['restrict','purge']),dueAt:z.coerce.date(),reason:z.string().min(1).max(2000),idempotencyKey:z.string().min(1).max(200)});
type Guard=(client:PoolClient)=>Promise<void>;
interface RequestRow {id:string;case_id:string;document_id:string|null;action:'restrict'|'purge';due_at:Date;status:'scheduled'|'cleanup_pending'|'complete';withdrawn_at:Date|null;last_error_code:string|null;requested_by:string}
interface DeletionRow {artifact_id:string;storage_key:string;sha256:string;status:string;attempts:number}
export interface RetentionStatus {id:string;caseId:string;documentId:string|null;action:string;dueAt:Date;status:string;withdrawnAt:Date|null;lastErrorCode:string|null;artifacts:{artifactId:string;status:string;attempts:number}[]}
const actorSchema=z.string().min(1).max(200);
const lockSql="SELECT pg_advisory_xact_lock(hashtext(current_schema()),173113)";

/** Storage namespace must belong exclusively to this database/schema. */
export async function withArtifactWriteLease<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>):Promise<T>{
  return transaction(pool,async client=>{
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext(current_schema()),173113)');
    return work(client);
  });
}
export async function readRetentionPolicy(database:Pool|PoolClient):Promise<z.infer<typeof RetentionPolicySchema>>{
  const row=(await database.query('SELECT enabled,artifact_gc_enabled AS "artifactGcEnabled" FROM retention_policy WHERE singleton=true')).rows[0];
  return RetentionPolicySchema.parse(row);
}
export async function setRetentionPolicy(pool:Pool,input:unknown,actor:string):Promise<z.infer<typeof RetentionPolicySchema>>{
  const policy=RetentionPolicySchema.parse(input);actorSchema.parse(actor);
  await transaction(pool,async client=>{
    await client.query('UPDATE retention_policy SET enabled=$1,artifact_gc_enabled=$2,updated_by=$3,updated_at=now() WHERE singleton=true',[policy.enabled,policy.artifactGcEnabled,actor]);
    await client.query("INSERT INTO retention_events(actor,event,details) VALUES($1,'policy_changed',$2)",[actor,JSON.stringify(policy)]);
  });
  return policy;
}
export async function readRetentionRequest(database:Pool|PoolClient,requestId:string):Promise<RetentionStatus>{
  const row=(await database.query<RequestRow>('SELECT * FROM retention_requests WHERE id=$1',[z.uuid().parse(requestId)])).rows[0];
  if(!row)throw new SourceError('not_found','Retention request not found');
  const artifacts=(await database.query<DeletionRow>('SELECT artifact_id,status,attempts FROM retention_artifact_deletions WHERE request_id=$1 ORDER BY artifact_id',[requestId])).rows;
  return {id:row.id,caseId:row.case_id,documentId:row.document_id,action:row.action,dueAt:row.due_at,status:row.status,withdrawnAt:row.withdrawn_at,lastErrorCode:row.last_error_code,
    artifacts:artifacts.map(item=>({artifactId:item.artifact_id,status:item.status,attempts:item.attempts}))};
}
export async function requestRetention(pool:Pool,input:unknown,actor:string):Promise<RetentionStatus>{
  const request=RetentionRequestSchema.parse(input);actorSchema.parse(actor);
  return transaction(pool,async client=>{
    if(!(await client.query('SELECT 1 FROM cases WHERE id=$1',[request.caseId])).rowCount)throw new SourceError('not_found','Case not found');
    if(request.documentId&&!(await client.query('SELECT 1 FROM documents WHERE id=$1 AND case_id=$2',[request.documentId,request.caseId])).rowCount)throw new SourceError('not_found','Document does not belong to case');
    const inserted=(await client.query<{id:string}>(`INSERT INTO retention_requests(idempotency_key,case_id,document_id,action,due_at,reason,requested_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`,
      [request.idempotencyKey,request.caseId,request.documentId??null,request.action,request.dueAt,request.reason,actor])).rows[0];
    let requestId=inserted?.id;
    if(!requestId){
      const existing=(await client.query<{id:string;matches:boolean}>(`SELECT id,(case_id=$2 AND document_id IS NOT DISTINCT FROM $3::uuid AND action=$4 AND due_at=$5 AND reason=$6 AND requested_by=$7) AS matches
        FROM retention_requests WHERE idempotency_key=$1`,[request.idempotencyKey,request.caseId,request.documentId??null,request.action,request.dueAt,request.reason,actor])).rows[0]!;
      if(!existing.matches)throw new JobConflictError();requestId=existing.id;
    }else await client.query("INSERT INTO retention_events(request_id,actor,event,details) VALUES($1,$2,'requested',$3)",[requestId,actor,JSON.stringify({action:request.action,scope:request.documentId?'document':'case'})]);
    return readRetentionRequest(client,requestId);
  });
}

async function withdraw(client:PoolClient,request:RequestRow):Promise<void>{
  const documentIds=(await client.query<{id:string}>('SELECT id FROM documents WHERE case_id=$1 AND ($2::uuid IS NULL OR id=$2)',[request.case_id,request.document_id])).rows.map(row=>row.id);
  const versionIds=(await client.query<{id:string}>('SELECT id FROM document_versions WHERE document_id=ANY($1::uuid[])',[documentIds])).rows.map(row=>row.id);
  // Descend only from directly affected jobs, then include their ancestors; never
  // descend again from a shared ancestor into unrelated public sibling workflows.
  const affected=(await client.query<{id:string}>(`WITH RECURSIVE direct(id) AS (
    SELECT id FROM jobs WHERE ($1::boolean AND payload->>'caseId'=$2)
      OR payload->>'documentId'=ANY($3::text[]) OR payload->>'documentVersionId'=ANY($4::text[])
  ), descendants(id) AS (SELECT id FROM direct UNION SELECT l.child_id FROM job_links l JOIN descendants d ON l.parent_id=d.id),
  ancestors(id) AS (SELECT id FROM direct UNION SELECT l.parent_id FROM job_links l JOIN ancestors a ON l.child_id=a.id),
  affected(id) AS (SELECT id FROM descendants UNION SELECT id FROM ancestors)
  SELECT j.id FROM jobs j JOIN affected a ON a.id=j.id ORDER BY j.id FOR UPDATE OF j`,[request.document_id===null,request.case_id,documentIds,versionIds])).rows.map(row=>row.id);
  await client.query("UPDATE job_attempts SET status=CASE WHEN status='running' THEN 'cancelled' ELSE status END,finished_at=coalesce(finished_at,clock_timestamp()),error=NULL WHERE job_id=ANY($1::uuid[])",[affected]);
  await client.query(`UPDATE jobs SET retention_request_id=$2,payload=jsonb_strip_nulls(jsonb_build_object('caseId',payload->>'caseId','documentId',payload->>'documentId')),
    result=NULL,error=NULL,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])`,[affected,request.id]);
  await client.query('SELECT id FROM cases WHERE id=$1 FOR UPDATE',[request.case_id]);
  await client.query('SELECT id FROM documents WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[documentIds]);
  if(request.document_id===null)await client.query('UPDATE cases SET retention_withdrawn_at=coalesce(retention_withdrawn_at,clock_timestamp()) WHERE id=$1',[request.case_id]);
  await client.query('UPDATE documents SET retention_withdrawn_at=coalesce(retention_withdrawn_at,clock_timestamp()) WHERE id=ANY($1::uuid[])',[documentIds]);
  await client.query("INSERT INTO retention_events(request_id,actor,event,details) VALUES($1,$2,'withdrawn',$3)",[request.id,request.requested_by,JSON.stringify({documents:documentIds.length,jobs:affected.length})]);
  if(request.action==='purge'){
    await client.query(`INSERT INTO retention_artifact_deletions(request_id,artifact_id,sha256,storage_key)
      SELECT DISTINCT $1::uuid,a.id,a.sha256,a.storage_key FROM artifacts a WHERE a.id IN (
        SELECT artifact_id FROM document_versions WHERE document_id=ANY($2::uuid[])
        UNION SELECT artifact_id FROM artifact_acquisition_attempts WHERE document_id=ANY($2::uuid[]))
      ON CONFLICT DO NOTHING`,[request.id,documentIds]);
    await client.query('DELETE FROM case_interpretation_runs WHERE id IN (SELECT run_id FROM case_interpretation_inputs WHERE document_id=ANY($1::uuid[]))',[documentIds]);
    await client.query('UPDATE documents SET retention_purged_at=clock_timestamp() WHERE id=ANY($1::uuid[])',[documentIds]);
    await client.query('DELETE FROM artifact_acquisition_attempts WHERE document_id=ANY($1::uuid[])',[documentIds]);
    await client.query('DELETE FROM document_versions WHERE document_id=ANY($1::uuid[])',[documentIds]);
    if(request.document_id===null){
      await client.query('DELETE FROM case_interpretation_runs WHERE case_id=$1',[request.case_id]);
      await client.query('UPDATE documents SET entry_id=NULL WHERE case_id=$1',[request.case_id]);
      await client.query('DELETE FROM docket_snapshots WHERE case_id=$1',[request.case_id]);
      await client.query('DELETE FROM docket_entries WHERE case_id=$1',[request.case_id]);
      await client.query('DELETE FROM participants WHERE case_id=$1',[request.case_id]);
      await client.query('DELETE FROM proceedings WHERE case_id=$1',[request.case_id]);
      await client.query('DELETE FROM relationships WHERE case_id=$1',[request.case_id]);
      await client.query('DELETE FROM case_status_history WHERE case_id=$1',[request.case_id]);
      await client.query('UPDATE cases SET retention_purged_at=clock_timestamp() WHERE id=$1',[request.case_id]);
      await client.query('DELETE FROM case_identifiers WHERE case_id=$1',[request.case_id]);
      await client.query("UPDATE feed_import_rows SET raw_text='',raw_bytes=''::bytea,raw=NULL,normalized='{}',error=NULL WHERE case_id=$1",[request.case_id]);
    }
    await client.query("UPDATE audit_events SET details='{}' WHERE resource_id=ANY($1::text[])",[[request.case_id,...documentIds,...versionIds,...affected]]);
    await client.query("INSERT INTO retention_events(request_id,actor,event,details) VALUES($1,$2,'data_purged',$3)",[request.id,request.requested_by,JSON.stringify({documents:documentIds.length})]);
  }
  const pending=request.action==='purge'&&(await client.query('SELECT 1 FROM retention_artifact_deletions WHERE request_id=$1 AND status=\'pending\'',[request.id])).rowCount!==0;
  await client.query(`UPDATE retention_requests SET withdrawn_at=clock_timestamp(),purged_at=CASE WHEN action='purge' THEN clock_timestamp() END,
    status=$2,completed_at=CASE WHEN $2='complete' THEN clock_timestamp() END,updated_at=clock_timestamp() WHERE id=$1`,[request.id,pending?'cleanup_pending':'complete']);
}

export async function processRetentionRequest(pool:Pool,store:ArtifactStore,requestId:string,guard?:Guard):Promise<RetentionStatus>{
  z.uuid().parse(requestId);
  await transaction(pool,async client=>{
    await client.query(lockSql);await guard?.(client);
    if(!(await readRetentionPolicy(client)).enabled)return;
    const request=(await client.query<RequestRow>('SELECT * FROM retention_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!request)throw new SourceError('not_found','Retention request not found');
    if(request.status!=='scheduled'||request.due_at.getTime()>Date.now())return;
    await withdraw(client,request);await guard?.(client);
  });
  await transaction(pool,async client=>{
    await client.query(lockSql);await guard?.(client);
    const policy=await readRetentionPolicy(client);if(!policy.enabled||!policy.artifactGcEnabled)return;
    const request=(await client.query<RequestRow>('SELECT * FROM retention_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
    if(!request||request.status!=='cleanup_pending')return;
    const deletions=(await client.query<DeletionRow>("SELECT * FROM retention_artifact_deletions WHERE request_id=$1 AND status='pending' ORDER BY artifact_id FOR UPDATE",[requestId])).rows;
    let errorCode:string|null=null;
    for(const item of deletions){
      await guard?.(client);
      await client.query('UPDATE retention_artifact_deletions SET attempts=attempts+1 WHERE request_id=$1 AND artifact_id=$2',[requestId,item.artifact_id]);
      const retained=(await client.query('SELECT 1 FROM document_versions WHERE artifact_id=$1 UNION ALL SELECT 1 FROM artifact_acquisition_attempts WHERE artifact_id=$1 LIMIT 1',[item.artifact_id])).rowCount;
      if(retained){
        await client.query("UPDATE retention_artifact_deletions SET status='retained',last_error_code=NULL,updated_at=now() WHERE request_id=$1 AND artifact_id=$2",[requestId,item.artifact_id]);
        await client.query("INSERT INTO retention_events(request_id,actor,event,details) VALUES($1,$2,'artifact_retained',$3)",[requestId,request.requested_by,JSON.stringify({sha256:item.sha256})]);continue;
      }
      const validKey=item.storage_key===`sha256/${item.sha256.slice(0,2)}/${item.sha256}`;
      let failed=!validKey;
      if(validKey){try{await store.remove(item.storage_key);}catch{failed=true;}}
      if(failed){
        errorCode=validKey?'artifact_delete_failed':'invalid_artifact_key';
        await client.query('UPDATE retention_artifact_deletions SET last_error_code=$3,updated_at=now() WHERE request_id=$1 AND artifact_id=$2',[requestId,item.artifact_id,errorCode]);
        await client.query("INSERT INTO retention_events(request_id,actor,event,details) VALUES($1,$2,'artifact_failed',$3)",[requestId,request.requested_by,JSON.stringify({code:errorCode})]);continue;
      }
      await client.query('DELETE FROM artifacts WHERE id=$1',[item.artifact_id]);
      await client.query("UPDATE retention_artifact_deletions SET status='deleted',last_error_code=NULL,updated_at=now() WHERE request_id=$1 AND artifact_id=$2",[requestId,item.artifact_id]);
      await client.query("INSERT INTO retention_events(request_id,actor,event,details) VALUES($1,$2,'artifact_deleted',$3)",[requestId,request.requested_by,JSON.stringify({sha256:item.sha256})]);
    }
    const pending=(await client.query("SELECT 1 FROM retention_artifact_deletions WHERE request_id=$1 AND status='pending'",[requestId])).rowCount!==0;
    await guard?.(client);
    await client.query(`UPDATE retention_requests SET status=$2,last_error_code=$3,completed_at=CASE WHEN $2='complete' THEN clock_timestamp() END,updated_at=now() WHERE id=$1`,[requestId,pending?'cleanup_pending':'complete',errorCode]);
    if(!pending)await client.query("INSERT INTO retention_events(request_id,actor,event) VALUES($1,$2,'complete')",[requestId,request.requested_by]);
  });
  return readRetentionRequest(pool,requestId);
}
export async function processDueRetention(pool:Pool,store:ArtifactStore,options:{limit?:number;guard?:Guard}={}):Promise<RetentionStatus[]>{
  if(!(await readRetentionPolicy(pool)).enabled)return [];
  const limit=z.number().int().min(1).max(100).parse(options.limit??20);
  const requests=(await pool.query<{id:string}>("SELECT id FROM retention_requests WHERE status<>'complete' AND due_at<=now() ORDER BY due_at,id LIMIT $1",[limit])).rows;
  const results:RetentionStatus[]=[];
  for(const request of requests)results.push(await processRetentionRequest(pool,store,request.id,options.guard));
  return results;
}
