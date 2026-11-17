import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readFile,readdir,realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { JobQueue,JobConflictError } from './jobs.js';
import type { Job, EnqueueInput } from './jobs.js';
import { transaction } from './database.js';
import { CourtSearchQuerySchema,QueryFiltersSchema,SourceError } from './contracts.js';
import type { CourtSourceAdapter,CaseObservation,DocumentReference } from './contracts.js';
import type { ArtifactStore } from './storage.js';
import { sha256,validatePdf,GcsArtifactStore } from './storage.js';
import { reconcileObservation,canonicalJson } from './reconcile.js';
import { processInWorker } from './processing-runner.js';
import { eventIdentity } from './identity.js';
import { findSystemChrome } from '../browser.js';
import { CONFIG } from '../config.js';
import { readRefreshPolicy,RefreshPolicySchema,RefreshPolicyPatchSchema,scheduleNextRefresh } from './refresh.js';
import type { RefreshPolicy } from './refresh.js';
import { settleDiscoveryFailures } from './discovery.js';
import { withArtifactWriteLease,readRetentionPolicy,setRetentionPolicy,requestRetention,readRetentionRequest,processRetentionRequest } from './retention.js';
import { caseInterpretationConfigFromEnv,interpretCase,getCaseInterpretation } from './case-interpretation.js';
const id=z.string().uuid();
const keySchema=z.string().min(1).max(200);
const objectSchema=z.record(z.string(),z.unknown());
const PUBLIC_NOTE='Results describe observed records, not an exhaustive court inventory. A database miss does not establish source absence.';

export class CourtService {
  readonly jobs:JobQueue;
  allowedSourceIds():string[]{return [...this.adapters.values()].filter(adapter=>{const metadata=adapter.metadata();return !metadata.processOptInEnvironment||process.env[metadata.processOptInEnvironment]==='true';}).map(adapter=>adapter.metadata().id);}
  async getRetentionPolicy(){return readRetentionPolicy(this.pool);}
  async setRetentionPolicy(policy:unknown){return setRetentionPolicy(this.pool,policy,'operator');}
  async requestRetention(input:unknown){return requestRetention(this.pool,input,'operator');}
  async getRetentionRequest(requestId:string){return readRetentionRequest(this.pool,requestId);}
  async runRetention(requestId:string,key:string){const request=await readRetentionRequest(this.pool,requestId);const job=await this.jobs.enqueue({type:'retention',payload:{requestId},idempotencyKey:keySchema.parse(key),availableAt:request.dueAt});return {jobId:job.id,status:job.status};}
  async getCaseInterpretation(caseId:string){await this.getCase(caseId);return getCaseInterpretation(this.pool,caseId);}
  async requestCaseInterpretation(caseId:string,key:string){await this.getCase(caseId);if(!caseInterpretationConfigFromEnv())throw new SourceError('unsupported','Case inference is disabled');const job=await this.jobs.enqueue({type:'interpret_case',payload:{caseId},idempotencyKey:keySchema.parse(key)});return {jobId:job.id,status:job.status};}
  constructor(readonly pool:Pool,readonly store:ArtifactStore,readonly adapters:Map<string,CourtSourceAdapter>,private readonly liveBudget?:{beforeRequest:()=>Promise<void>;recordBytes:(bytes:number)=>void;reserveDocument:()=>boolean}){this.jobs=new JobQueue(pool);}
  private async fence(client:PoolClient,job:Job):Promise<void>{
    const lease=await client.query("SELECT 1 FROM jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>clock_timestamp() FOR UPDATE",[job.id,job.leaseToken]);
    if(!lease.rowCount)throw new SourceError('permanent','Job lease lost or cancelled before persistence');
  }
  private async enqueueChild(job:Job,input:EnqueueInput):Promise<Job>{
    return transaction(this.pool,async client=>{
      await this.fence(client,job);
      const child=await this.jobs.enqueue(input,client);
      await client.query('INSERT INTO job_links(parent_id,child_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[job.id,child.id]);
      return child;
    });
  }
  async admitRequest(principal:string,limit=120,windowMs=60000):Promise<boolean>{
    z.string().min(1).max(512).parse(principal);z.number().int().positive().parse(limit);z.number().int().positive().parse(windowMs);
    const result=await this.pool.query<{requests:number}>(`INSERT INTO request_budgets(principal_hash,window_start,requests)
      VALUES($1,to_timestamp(floor(extract(epoch FROM clock_timestamp())*1000/$2)*$2/1000),1)
      ON CONFLICT(principal_hash,window_start) DO UPDATE SET requests=request_budgets.requests+1 RETURNING requests`,[sha256(principal),windowMs]);
    return result.rows[0]!.requests<=limit;
  }
  async recordAudit(actor:string,action:string,resourceType:string,resourceId:string|null,details:Record<string,unknown>):Promise<void>{
    await this.pool.query('INSERT INTO audit_events(actor,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5)',[actor,action,resourceType,resourceId,JSON.stringify(details)]);
  }
  async registerSources():Promise<void>{
    for(const adapter of this.adapters.values()){
      const m=adapter.metadata();const enabled=m.fixture;
      await this.pool.query(`INSERT INTO sources(id,state,name,metadata,capabilities,enabled,min_interval_ms) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET metadata=EXCLUDED.metadata,capabilities=EXCLUDED.capabilities,name=EXCLUDED.name,updated_at=now()`,[m.id,m.state,m.name,JSON.stringify(m),JSON.stringify(adapter.capabilities()),enabled,m.fixture?0:15000]);
    }
  }
  private adapter(sourceId:string):CourtSourceAdapter {const adapter=this.adapters.get(sourceId);if(!adapter)throw new SourceError('unsupported',`Unknown court source: ${sourceId}`);return adapter;}
  async listSources():Promise<unknown>{return {data:(await this.pool.query('SELECT id,state,name,metadata,capabilities,enabled,health,paused_until FROM sources ORDER BY id')).rows};}
  async getCapabilities(sourceId:string):Promise<unknown>{return this.adapter(sourceId).capabilities();}
  async controlSource(sourceId:string,action:'enable'|'disable'|'pause'|'resume',reason:string,minutes?:number):Promise<unknown>{
    z.enum(['enable','disable','pause','resume']).parse(action);z.string().min(1).max(2000).parse(reason);
    if(action!=='pause'&&minutes!==undefined)throw new SourceError('permanent','Duration is valid only for pause');
    const duration=z.number().int().min(1).max(10080).parse(minutes??60);
    return transaction(this.pool,async client=>{
      const result=await client.query(`UPDATE sources SET enabled=CASE WHEN $2='enable' THEN true WHEN $2='disable' THEN false ELSE enabled END,
        paused_until=CASE WHEN $2='pause' THEN clock_timestamp()+$3*interval '1 minute' WHEN $2='resume' THEN NULL ELSE paused_until END,
        updated_at=now() WHERE id=$1 RETURNING id,enabled,paused_until,health`,[sourceId,action,duration]);
      if(!result.rows[0])throw new SourceError('not_found','Source not registered');
      await client.query("INSERT INTO audit_events(actor,action,resource_type,resource_id,details) VALUES('operator','source_policy','source',$1,$2)",[sourceId,JSON.stringify({action,reason,...(action==='pause'?{minutes:duration}:{})})]);
      return {...result.rows[0],note:'Administrative state is not source authorization. Process opt-in and existing job retry deadlines still apply.'};
    });
  }
  private filters(input:Record<string,unknown>){return QueryFiltersSchema.parse(input);}
  private order(input:Record<string,unknown>):string{
    const f=this.filters(input);
    const columns={observedAt:'c.last_observed_at',caseNumber:'c.case_number',court:'c.court',status:'c.status',filedDate:"c.metadata->>'filedDate'"};
    return `${columns[f.sortBy??'observedAt']} ${f.sortOrder==='asc'?'ASC':'DESC'} NULLS LAST,c.id`;
  }
  private where(input:Record<string,unknown>,includeText=true,includeDocuments=true):{where:string;values:unknown[];limit:number;offset:number}{
    const f=this.filters(input);const terms=["c.availability='public'"];const values:unknown[]=[];
    const add=(sql:string,value:unknown)=>{values.push(value);terms.push(sql.replaceAll('?',`$${values.length}`));};
    if(f.sourceId)add('c.source_id=?',f.sourceId);
    if(f.state)add('s.state=?',f.state.toUpperCase());
    if(f.caseId)add('c.id=?',f.caseId);
    if(f.caseNumber)add("upper(regexp_replace(c.case_number,'[^a-zA-Z0-9]','','g'))=upper(regexp_replace(?,'[^a-zA-Z0-9]','','g'))",f.caseNumber);
    if(f.status)add('lower(c.status)=lower(?)',f.status);
    if(f.court)add('c.court ILIKE ?',`%${f.court}%`);
    if(f.county)add("(c.court ILIKE ? OR c.metadata->>'county' ILIKE ?)",`%${f.county}%`);
    if(f.category)add("c.metadata->>'category' ILIKE ?",`%${f.category}%`);
    if(includeText&&f.q)add("to_tsvector('simple',c.title||' '||c.case_number) @@ websearch_to_tsquery('simple',?)",f.q);
    for(const [role,value] of [['party',f.party],['attorney',f.attorney],['judge',f.judge],['organization',f.organization]] as const){
      if(value)add(`EXISTS(SELECT 1 FROM participants p WHERE p.case_id=c.id AND p.name ILIKE ? ${role==='party'?'':`AND (p.kind ILIKE '%${role}%' OR p.role ILIKE '%${role}%')`})`,`%${value}%`);
    }
    if(f.filedFrom)add("c.metadata->>'filedDate' >= ?",f.filedFrom);
    if(f.filedTo)add("c.metadata->>'filedDate' <= ?",f.filedTo);
    if(includeDocuments&&f.documentType)add("EXISTS(SELECT 1 FROM documents d0 JOIN LATERAL (SELECT result FROM extraction_runs WHERE document_version_id=d0.current_version_id AND status IN ('complete','partial') ORDER BY finished_at DESC,id DESC LIMIT 1) r0 ON true WHERE d0.case_id=c.id AND d0.availability='available' AND lower(?) IN (lower(r0.result->'classification'->>'label'),lower(r0.result->'classification'->>'family')))",f.documentType);
    if(includeDocuments&&f.citation)add("EXISTS(SELECT 1 FROM documents d0 JOIN LATERAL (SELECT id FROM extraction_runs WHERE document_version_id=d0.current_version_id AND status IN ('complete','partial') ORDER BY finished_at DESC,id DESC LIMIT 1) r0 ON true JOIN entity_mentions e0 ON e0.extraction_run_id=r0.id WHERE d0.case_id=c.id AND d0.availability='available' AND e0.kind IN ('reporter_citation','case_number','statute','rule') AND e0.value ILIKE ?)",`%${f.citation}%`);
    return {where:terms.join(' AND '),values,limit:f.limit,offset:f.offset};
  }
  private async page(sql:string,values:unknown[],limit:number,offset:number):Promise<unknown>{
    const result=await this.pool.query<Record<string,unknown>>(`${sql} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,limit+1,offset]);
    return {data:result.rows.slice(0,limit),meta:{limit,offset,hasMore:result.rows.length>limit},coverageNote:PUBLIC_NOTE};
  }
  async searchCases(filters:Record<string,unknown>={}):Promise<unknown>{const f=this.where(filters);return this.page(`SELECT c.*,CASE WHEN EXISTS(SELECT 1 FROM documents rd WHERE rd.case_id=c.id AND rd.retention_withdrawn_at IS NOT NULL) THEN '{}'::jsonb ELSE c.metadata END AS metadata,s.name AS source_name,s.metadata->>'adapterVersion' AS adapter_version FROM cases c JOIN sources s ON s.id=c.source_id WHERE ${f.where} ORDER BY ${this.order(filters)}`,f.values,f.limit,f.offset);}
  async searchDocketEntries(filters:Record<string,unknown>={}):Promise<unknown>{
    const f=this.where(filters,false);const q=this.filters(filters).q;
    if(q){f.values.push(q);f.where+=` AND to_tsvector('simple',e.title) @@ websearch_to_tsquery('simple',$${f.values.length})`;}
    return this.page(`SELECT e.*,CASE WHEN EXISTS(SELECT 1 FROM documents rd WHERE rd.entry_id=e.id AND rd.availability<>'available') THEN '{}'::jsonb ELSE e.raw END AS raw,c.case_number,c.source_id,c.last_observed_at,
      coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'title',d.title,'sourceDocumentId',d.source_document_id,'availability',d.availability,'acquisitionStatus',d.acquisition_status,'currentVersionId',d.current_version_id) ORDER BY d.id)
        FROM documents d WHERE d.entry_id=e.id AND d.availability='available'),'[]'::jsonb) AS documents
      FROM docket_entries e JOIN cases c ON c.id=e.case_id JOIN sources s ON s.id=c.source_id WHERE ${f.where} AND e.availability='public' ORDER BY ${this.order(filters)},e.source_order,e.id`,f.values,f.limit,f.offset);
  }
  async searchFilingText(filters:Record<string,unknown>={}):Promise<unknown>{
    const f=this.where(filters,false,false);const parsed=this.filters(filters);const q=parsed.q;
    if(parsed.documentType){f.values.push(parsed.documentType);f.where+=` AND lower($${f.values.length}) IN (lower(r.result->'classification'->>'label'),lower(r.result->'classification'->>'family'))`;}
    if(parsed.citation){f.values.push(`%${parsed.citation}%`);f.where+=` AND EXISTS(SELECT 1 FROM entity_mentions em WHERE em.extraction_run_id=r.id AND em.kind IN ('reporter_citation','case_number','statute','rule') AND em.value ILIKE $${f.values.length})`;}
    if(q){f.values.push(q);f.where+=` AND ch.search_vector @@ websearch_to_tsquery('english',$${f.values.length})`;}
    return this.page(`SELECT ch.*,d.id AS document_id,d.title,c.case_number,c.source_id,c.last_observed_at,dv.id AS document_version_id,r.pipeline_version,r.status AS extraction_status FROM chunks ch JOIN extraction_runs r ON r.id=ch.extraction_run_id JOIN document_versions dv ON dv.id=r.document_version_id JOIN documents d ON d.id=dv.document_id JOIN cases c ON c.id=d.case_id JOIN sources s ON s.id=c.source_id WHERE ${f.where} AND d.availability='available' AND r.status IN ('complete','partial') AND dv.id=d.current_version_id AND r.id=(SELECT id FROM extraction_runs WHERE document_version_id=dv.id AND status IN ('complete','partial') ORDER BY finished_at DESC,id DESC LIMIT 1) ORDER BY ${this.order(filters)},d.id,ch.page_number,ch.start_offset`,f.values,f.limit,f.offset);
  }
  async getCase(caseId:string):Promise<unknown>{
    const result=await this.pool.query("SELECT c.*,CASE WHEN EXISTS(SELECT 1 FROM documents rd WHERE rd.case_id=c.id AND rd.retention_withdrawn_at IS NOT NULL) THEN '{}'::jsonb ELSE c.metadata END AS metadata,s.metadata AS source FROM cases c JOIN sources s ON s.id=c.source_id WHERE c.id=$1 AND c.availability='public'",[id.parse(caseId)]);
    if(!result.rows[0])throw new SourceError('not_found','Case not found or restricted');return {...result.rows[0],coverageNote:PUBLIC_NOTE};
  }
  async getCaseDocket(caseId:string,filters:Record<string,unknown>={}):Promise<unknown>{await this.getCase(caseId);return this.searchDocketEntries({...filters,caseId});}
  async getFiling(documentId:string):Promise<unknown>{
    const result=await this.pool.query("SELECT d.*,CASE WHEN EXISTS(SELECT 1 FROM documents rd WHERE rd.case_id=c.id AND rd.retention_withdrawn_at IS NOT NULL) THEN d.reference-'raw' ELSE d.reference END AS reference,c.source_id,c.case_number,c.last_observed_at FROM documents d JOIN cases c ON c.id=d.case_id WHERE d.id=$1 AND c.availability='public' AND d.availability='available'",[id.parse(documentId)]);
    if(!result.rows[0])throw new SourceError('not_found','Document not found or restricted');
    return {...result.rows[0],versions:(await this.pool.query('SELECT dv.id,dv.filename,dv.source_url,dv.acquired_at,a.sha256,a.size_bytes,a.content_type FROM document_versions dv JOIN artifacts a ON a.id=dv.artifact_id WHERE document_id=$1 ORDER BY acquired_at DESC,id DESC',[documentId])).rows};
  }
  async getDocumentText(documentId:string,filters:Record<string,unknown>={}):Promise<unknown>{
    await this.getFiling(documentId);const f=this.filters(filters);
    return this.page(`SELECT p.*,r.pipeline_version,r.status,r.model,r.schema_version,r.document_version_id FROM pages p JOIN extraction_runs r ON r.id=p.extraction_run_id WHERE r.id=(SELECT r2.id FROM extraction_runs r2 JOIN documents d ON d.current_version_id=r2.document_version_id JOIN cases c ON c.id=d.case_id WHERE d.id=$1 AND d.availability='available' AND c.availability='public' AND r2.status IN ('complete','partial') ORDER BY r2.finished_at DESC,r2.id DESC LIMIT 1) ORDER BY p.page_number`,[documentId],f.limit,f.offset);
  }
  async getDocumentArtifact(documentId:string):Promise<{bytes:Buffer;filename:string;contentType:string}>{
    await this.getFiling(documentId);const row=(await this.pool.query<{storage_key:string;filename:string;content_type:string}>('SELECT a.storage_key,dv.filename,a.content_type FROM documents d JOIN document_versions dv ON dv.id=d.current_version_id JOIN artifacts a ON a.id=dv.artifact_id WHERE d.id=$1',[documentId])).rows[0];
    if(!row)throw new SourceError('not_found','Artifact not acquired');
    const bytes=await this.store.get(row.storage_key);await this.getFiling(documentId);
    return {bytes,filename:row.filename,contentType:row.content_type};
  }
  async requestAcquisition(input:unknown,key:string):Promise<unknown>{
    const parsed=CourtSearchQuerySchema.parse(input);const query=this.adapter(parsed.sourceId).validateSearch(parsed);
    const job=await this.jobs.enqueue({type:'source_search',sourceId:query.sourceId,payload:{query},idempotencyKey:keySchema.parse(key)});
    return {jobId:job.id,status:job.status};
  }
  async requestBulk(input:unknown,key:string):Promise<unknown>{
    const body=z.strictObject({queries:z.array(z.unknown()).min(1).max(10000),acquireResults:z.boolean().optional()}).parse(input);
    const queries=body.queries.map((query,index)=>{try{const q=CourtSearchQuerySchema.parse(query);const valid=this.adapter(q.sourceId).validateSearch({...q,acquireResults:q.acquireResults??body.acquireResults??true});return {index,query:valid};}catch(error){return {index,error:error instanceof Error?error.message:String(error)};}});
    const job=await this.jobs.enqueue({type:'bulk_search',payload:{queries},idempotencyKey:keySchema.parse(key)});return {jobId:job.id,status:job.status,validation:queries.map(item=>({index:item.index,...('error' in item?{error:item.error}:{valid:true})}))};
  }
  async requestRefresh(caseId:string,key:string):Promise<unknown>{
    const row=await this.pool.query("SELECT 1 FROM cases WHERE id=$1 AND availability='public'",[id.parse(caseId)]);
    if(!row.rowCount)throw new SourceError('not_found','Case not found or restricted');
    // The durable request preserves each caller's key even when several requests
    // share one active acquisition. Workflow status follows the linked child.
    const job=await this.jobs.enqueue({type:'refresh_request',payload:{caseId},idempotencyKey:keySchema.parse(key)});
    return {jobId:job.id,status:job.status};
  }
  async getJobStatus(jobId:string):Promise<unknown>{
    const job=(await this.pool.query<Record<string,unknown>>('SELECT id,source_id,type,status,priority,attempts,max_attempts,available_at,result,error,created_at,updated_at FROM jobs WHERE id=$1',[id.parse(jobId)])).rows[0];
    if(!job)throw new SourceError('not_found','Job not found');
    const descendants=await this.pool.query<{id:string;type:string;status:string}>(`WITH RECURSIVE tree(id) AS (
      SELECT child_id FROM job_links WHERE parent_id=$1 UNION SELECT l.child_id FROM job_links l JOIN tree t ON l.parent_id=t.id)
      SELECT j.id,j.type,j.status FROM jobs j JOIN tree t ON t.id=j.id`,[jobId]);
    const statuses=[String(job['status']),...descendants.rows.map(row=>row.status)];
    const restricted=(await this.pool.query<{restricted:boolean}>(`WITH RECURSIVE tree(id) AS (
      SELECT $1::uuid UNION SELECT l.child_id FROM job_links l JOIN tree t ON l.parent_id=t.id)
      SELECT EXISTS(SELECT 1 FROM tree t JOIN jobs j ON j.id=t.id
        LEFT JOIN cases c ON c.id::text=j.payload->>'caseId'
        LEFT JOIN documents d ON d.id::text=j.payload->>'documentId'
        LEFT JOIN document_versions v ON v.id::text=j.payload->>'documentVersionId'
        LEFT JOIN documents vd ON vd.id=v.document_id
        WHERE c.availability<>'public' OR d.availability<>'available' OR vd.availability<>'available') AS restricted`,[jobId])).rows[0]!.restricted;
    const workflowStatus=statuses.includes('running')||statuses.includes('queued')||statuses.includes('retry_wait')?'pending':
      statuses.includes('blocked')?'blocked':statuses.includes('cancelled')?'cancelled':
      statuses.some(status=>status!=='complete')?'partial':'complete';
    const attempts=(await this.pool.query<Record<string,unknown>>('SELECT attempt,started_at,finished_at,status,error FROM job_attempts WHERE job_id=$1 ORDER BY attempt',[jobId])).rows;
    return {...job,...(restricted?{result:null,error:null,contentRestricted:true}:{}),
      status:workflowStatus,stageStatus:job['status'],workflowStatus,children:descendants.rows,
      attemptsHistory:restricted?attempts.map(({error:_error,...attempt})=>attempt):attempts};
  }
  async retryJob(jobId:string):Promise<unknown>{return {retried:await this.jobs.retry(id.parse(jobId))};}
  async cancelJob(jobId:string):Promise<unknown>{return {cancelled:await this.jobs.cancel(id.parse(jobId))};}
  async getCoverageReport(filters:Record<string,unknown>={}):Promise<unknown>{
    const f=this.filters(filters);const values:unknown[]=[];const terms=['true'];
    const add=(sql:string,value:unknown)=>{values.push(value);terms.push(sql.replaceAll('?',`$${values.length}`));};
    if(f.sourceId)add('o.source_id=?',f.sourceId);
    if(f.state)add('s.state=?',f.state.toUpperCase());
    if(f.court)add("o.scope->>'court' ILIKE ?",`%${f.court}%`);
    if(f.county)add("(o.scope->>'county'=? OR o.scope->'counties' @> jsonb_build_array(?::text))",f.county);
    if(f.category)add("o.scope->'categories' @> jsonb_build_array(?::text)",f.category);
    if(f.filedFrom)add("o.scope->>'filedTo'>=?",f.filedFrom);
    if(f.filedTo)add("o.scope->>'filedFrom'<=?",f.filedTo);
    for(const unsupported of ['caseId','caseNumber','q','status','party','attorney','judge','documentType','citation','organization'] as const){
      if(f[unsupported]!==undefined)throw new SourceError('unsupported',`Coverage does not support ${unsupported}`);
    }
    return this.page(`SELECT o.*,s.state FROM coverage_observations o JOIN sources s ON s.id=o.source_id WHERE ${terms.join(' AND ')} ORDER BY observed_at DESC,o.id`,values,f.limit,f.offset);
  }
  async planDiscovery(input:unknown):Promise<unknown>{
    const parsed=CourtSearchQuerySchema.parse(input);const query=this.adapter(parsed.sourceId).validateSearch(parsed);
    const hash=sha256(canonicalJson(query));
    const partitionId=await transaction(this.pool,async client=>{
      const inserted=(await client.query<{id:string}>("INSERT INTO discovery_partitions(source_id,query,query_hash,status,limitations,next_run_at) VALUES($1,$2,$3,'pending',$4,now()) ON CONFLICT(source_id,query_hash) DO NOTHING RETURNING id",
        [query.sourceId,JSON.stringify(query),hash,JSON.stringify(this.adapter(query.sourceId).capabilities().notes)])).rows[0];
      if(inserted)return inserted.id;
      const existing=(await client.query<{id:string}>('SELECT id FROM discovery_partitions WHERE source_id=$1 AND query_hash=$2 FOR UPDATE',[query.sourceId,hash])).rows[0]!;
      const active=await client.query("SELECT 1 FROM jobs WHERE type='source_search' AND payload->>'partitionId'=$1 AND status IN ('queued','running','retry_wait','blocked')",[existing.id]);
      if(!active.rowCount)await client.query(`UPDATE discovery_partitions SET status='pending',generation=generation+1,recovery_count=0,
        last_job_id=NULL,settled_job_id=NULL,settled_job_attempt=0,last_error_code=NULL,next_run_at=now(),updated_at=now() WHERE id=$1`,[existing.id]);
      return existing.id;
    });
    return {partitionId,query,denominator:null,coverageStatus:'unknown'};
  }
  private async enqueueCaseRefresh(client:PoolClient,caseId:string,key:string,policy:RefreshPolicy,parentId?:string):Promise<{id:string;status:string}>{
    const row=(await client.query<{source_id:string;source_case_id:string}>("SELECT source_id,source_case_id FROM cases WHERE id=$1 AND availability='public' FOR UPDATE",[caseId])).rows[0];
    if(!row)throw new SourceError('not_found','Case not found or restricted');
    // Readers never lock an existing job while holding a case row: worker and
    // restriction transactions acquire job locks before case locks.
    if(parentId){
      const linked=(await client.query<{id:string;status:string}>(`SELECT j.id,j.status FROM job_links l JOIN jobs j ON j.id=l.child_id
        WHERE l.parent_id=$1 AND j.type='refresh_case' AND j.payload->>'caseId'=$2 ORDER BY j.created_at,j.id LIMIT 1`,[parentId,caseId])).rows[0];
      if(linked)return linked;
    }
    const keyed=(await client.query<{id:string;status:string;matches:boolean}>(`SELECT id,status,
      (type='refresh_case' AND source_id=$2 AND payload=$3::jsonb AND NOT EXISTS(SELECT 1 FROM job_dependencies WHERE job_id=jobs.id)) AS matches
      FROM jobs WHERE idempotency_key=$1`,[key,row.source_id,JSON.stringify({caseId,sourceCaseId:row.source_case_id})])).rows[0];
    if(keyed){if(!keyed.matches)throw new JobConflictError();return {id:keyed.id,status:keyed.status};}
    const active=(await client.query<{id:string;status:string}>(`SELECT id,status FROM jobs WHERE type='refresh_case' AND payload->>'caseId'=$1
      AND status IN ('queued','running','retry_wait','blocked') ORDER BY created_at,id LIMIT 1`,[caseId])).rows[0];
    if(active)return active;
    const decision=await scheduleNextRefresh(client,caseId,policy);
    return this.jobs.enqueue({type:'refresh_case',sourceId:row.source_id,payload:{caseId,sourceCaseId:row.source_case_id},idempotencyKey:key,priority:decision.priority},client);
  }
  async getRefreshPolicy():Promise<{policy:RefreshPolicy}>{
    return {policy:await readRefreshPolicy(this.pool)};
  }
  async setRefreshPolicy(input:unknown):Promise<{policy:RefreshPolicy}>{
    const patch=RefreshPolicyPatchSchema.parse(input);
    if(!Object.keys(patch).length)throw new SourceError('permanent','At least one refresh policy setting is required');
    return transaction(this.pool,async client=>{
      const row=(await client.query<{policy:unknown}>('SELECT policy FROM refresh_policy WHERE singleton=true FOR UPDATE')).rows[0]!;
      const policy=RefreshPolicySchema.parse({...RefreshPolicySchema.parse(row.policy),...patch});
      await client.query('UPDATE refresh_policy SET policy=$1,updated_at=now() WHERE singleton=true',[JSON.stringify(policy)]);
      // Shorter policies take effect without waiting for an old long deadline;
      // longer policies never postpone already promised due work.
      await client.query(`UPDATE cases SET next_refresh_at=least(next_refresh_at,clock_timestamp()+
        ((($1::jsonb)->>(coalesce(refresh_class,'active')||'Minutes'))::integer*interval '1 minute'))
        WHERE next_refresh_at IS NOT NULL AND availability='public'`,[JSON.stringify(policy)]);
      return {policy};
    });
  }
  async setCaseWatch(caseId:string,enabled:boolean):Promise<unknown>{
    id.parse(caseId);z.boolean().parse(enabled);
    const result=await transaction(this.pool,async client=>{
      const row=(await client.query<{watched:boolean;next_refresh_at:Date|null}>("SELECT watched,next_refresh_at FROM cases WHERE id=$1 AND availability='public' FOR UPDATE",[caseId])).rows[0];
      if(!row)throw new SourceError('not_found','Case not found or restricted');
      if(row.watched!==enabled){
        await client.query('UPDATE cases SET watched=$2,updated_at=now() WHERE id=$1',[caseId,enabled]);
        if(enabled||row.next_refresh_at){
          await scheduleNextRefresh(client,caseId);
          if(enabled)await client.query('UPDATE cases SET next_refresh_at=least(next_refresh_at,coalesce($2::timestamptz,clock_timestamp())) WHERE id=$1',[caseId,row.next_refresh_at]);
        }
      }
      return (await client.query('SELECT id,watched,next_refresh_at,refresh_class,refresh_interval_minutes FROM cases WHERE id=$1',[caseId])).rows[0];
    });
    // No case lock is held while changing existing queued-job priority.
    await this.pool.query(`UPDATE jobs j SET priority=CASE WHEN c.watched THEN 100 ELSE 0 END
      FROM cases c WHERE c.id=$1 AND j.type='refresh_case' AND j.payload->>'caseId'=c.id::text AND j.status IN ('queued','retry_wait','blocked')`,[caseId]);
    return result;
  }
  async scheduleDue():Promise<unknown>{
    await this.pool.query("DELETE FROM request_budgets WHERE window_start<now()-interval '1 day'");
    const policy=await readRefreshPolicy(this.pool);
    // Expired workers and exhausted retries must not recycle an already-terminal key.
    await transaction(this.pool,client=>settleDiscoveryFailures(client));
    await this.pool.query(`UPDATE cases c SET next_refresh_at=CASE
      WHEN j.error->>'code' IN ('retryable','lease_expired') THEN j.updated_at+($1::integer*interval '1 minute') ELSE NULL END
      FROM jobs j WHERE c.availability='public' AND j.type='refresh_case'
      AND j.payload->>'caseId'=c.id::text AND j.status='dead_letter'
      AND NOT EXISTS(SELECT 1 FROM jobs newer WHERE newer.type='refresh_case' AND newer.payload->>'caseId'=c.id::text
        AND (newer.created_at,newer.id)>(j.created_at,j.id))`,[policy.failedMinutes]);
    await this.pool.query(`UPDATE jobs j SET priority=CASE WHEN c.watched THEN 100 ELSE 0 END FROM cases c
      WHERE j.type='refresh_case' AND j.payload->>'caseId'=c.id::text AND j.status IN ('queued','retry_wait','blocked')
      AND j.priority IS DISTINCT FROM CASE WHEN c.watched THEN 100 ELSE 0 END`);
    return transaction(this.pool,async client=>{
      const cases=await client.query<{id:string;next_refresh_at:Date}>(`SELECT c.id,c.next_refresh_at FROM cases c JOIN sources s ON s.id=c.source_id
        WHERE c.availability='public' AND c.next_refresh_at<=now() AND s.enabled AND (s.paused_until IS NULL OR s.paused_until<=now())
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.type='refresh_case' AND j.payload->>'caseId'=c.id::text AND j.status IN ('queued','running','retry_wait','blocked'))
        ORDER BY c.watched DESC,c.next_refresh_at,c.id LIMIT 500 FOR UPDATE OF c SKIP LOCKED`);
      const jobs:string[]=[];
      for(const row of cases.rows){
        const active=await client.query("SELECT 1 FROM jobs WHERE type='refresh_case' AND payload->>'caseId'=$1 AND status IN ('queued','running','retry_wait','blocked')",[row.id]);
        if(active.rowCount)continue;
        const job=await this.enqueueCaseRefresh(client,row.id,`refresh:${row.id}:${row.next_refresh_at.toISOString()}`,policy);jobs.push(job.id);
      }
      // Discovery has its own due time and capacity, never gated on tracked cases.
      const partitions=await client.query<{id:string;source_id:string;query:unknown;next_run_at:Date;generation:number}>(`SELECT p.id,p.source_id,p.query,p.next_run_at,p.generation
        FROM discovery_partitions p JOIN sources s ON s.id=p.source_id WHERE p.next_run_at<=now() AND p.status IN ('pending','complete','partial','truncated','blocked')
        AND s.enabled AND (s.paused_until IS NULL OR s.paused_until<=now())
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.type='source_search' AND j.payload->>'partitionId'=p.id::text AND j.status IN ('queued','running','retry_wait','blocked'))
        ORDER BY p.next_run_at,p.id LIMIT 500 FOR UPDATE OF p SKIP LOCKED`);
      for(const row of partitions.rows){
        const job=await this.jobs.enqueue({type:'source_search',sourceId:row.source_id,payload:{query:row.query,partitionId:row.id},idempotencyKey:`discover:${row.id}:${row.generation}:${row.next_run_at.toISOString()}`},client);
        if(!['queued','running','retry_wait','blocked'].includes(job.status)){
          await client.query("UPDATE discovery_partitions SET status='failed',next_run_at=NULL,last_error_code='terminal_idempotency_collision',updated_at=now() WHERE id=$1",[row.id]);
          continue;
        }
        await client.query("UPDATE discovery_partitions SET last_job_id=$2,status='queued',updated_at=now() WHERE id=$1",[row.id,job.id]);
        jobs.push(job.id);
      }
      return {scheduled:jobs.length,jobIds:jobs};
    });
  }
  async restrictCase(caseId:string,reason:string):Promise<unknown>{
    id.parse(caseId);z.string().min(1).max(2000).parse(reason);
    await transaction(this.pool,async client=>{
      await client.query("SELECT id FROM jobs WHERE payload->>'caseId'=$1 ORDER BY id FOR UPDATE",[caseId]);
      const changed=await client.query("UPDATE cases SET availability='restricted',updated_at=now() WHERE id=$1 RETURNING id",[caseId]);
      if(!changed.rowCount)throw new SourceError('not_found','Case not found');
      await client.query("UPDATE documents SET availability='restricted',updated_at=now() WHERE case_id=$1",[caseId]);
      await client.query("UPDATE job_attempts SET status='cancelled',finished_at=clock_timestamp() WHERE status='running' AND job_id IN (SELECT id FROM jobs WHERE payload->>'caseId'=$1)",[caseId]);
      await client.query("UPDATE jobs SET status='cancelled',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE payload->>'caseId'=$1 AND status IN ('queued','running','retry_wait','blocked')",[caseId]);
      await client.query("INSERT INTO audit_events(actor,action,resource_type,resource_id,details) VALUES('operator','restrict','case',$1,$2)",[caseId,JSON.stringify({reason})]);
    });return {caseId,availability:'restricted'};
  }
  async health():Promise<unknown>{
    await this.pool.query('SELECT 1');
    const sources = (await this.pool.query<{id:string;enabled:boolean;health:string;paused_until:string|null}>('SELECT id,enabled,health,paused_until FROM sources')).rows;
    const mnSource = sources.find(s => s.id === 'mn-mcro');
    const fixtureSource = sources.find(s => s.id === 'independent-fixture');
    const chrome = findSystemChrome();
    const mode = process.env.COURT_BROWSER_MODE ?? 'standalone';
    const headed = process.env.COURT_BROWSER_HEADED === 'true';
    const sessionFile = process.env.COURT_SESSION_FILE || CONFIG.sessionFile;
    const sessionPresent = existsSync(sessionFile);
    const activeJobs = (await this.pool.query<{count:number}>("SELECT count(*)::int AS count FROM jobs WHERE status IN ('running','queued')")).rows[0]?.count ?? 0;

    let storageHealthy = true;
    try {
      const probe = await this.store.put(Buffer.from('probe'));
      await this.store.remove(probe.storageKey);
    } catch {
      storageHealthy = false;
    }

    return {
      status: 'ok',
      database: 'reachable',
      time: new Date().toISOString(),
      details: {
        database: {
          status: 'reachable',
          pool: { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount },
        },
        browser: {
          mode,
          headed,
          executablePath: chrome ?? null,
          available: !!chrome,
          extensionBridge: {
            supported: false,
            reason: 'Playwriter CDP bridge cannot create isolated browser context (Target.createBrowserContext unsupported); standalone mode required',
          },
        },
        sources: {
          'mn-mcro': {
            durableEnabled: mnSource?.enabled ?? false,
            processOptIn: process.env.COURT_ALLOW_LIVE_MN === 'true',
            pausedUntil: mnSource?.paused_until ?? null,
            readyForLive: (mnSource?.enabled ?? false) && process.env.COURT_ALLOW_LIVE_MN === 'true',
          },
          'independent-fixture': {
            durableEnabled: fixtureSource?.enabled ?? true,
            ready: true,
          },
        },
        credentials: {
          apiReadTokenPresent: !!process.env.API_TOKEN_READ,
          apiWriteTokenPresent: !!process.env.API_TOKEN_WRITE,
          apiAdminTokenPresent: !!process.env.API_TOKEN_ADMIN,
          databaseConfigured: !!process.env.COURT_DATABASE_URL,
          sessionStatePresent: sessionPresent,
        },
        storage: {
          status: storageHealthy ? 'accessible' : 'degraded',
          type: this.store instanceof GcsArtifactStore ? 'gcs' : 'local',
        },
        worker: {
          activeOrQueuedJobs: activeJobs,
        },
        http: {
          configured: true,
        },
        mcp: {
          configured: true,
          role: process.env.MCP_ROLE || 'read',
        },
      },
    };
  }
  async metrics():Promise<unknown>{return {jobs:(await this.pool.query('SELECT status,type,count(*)::int AS count,min(created_at) AS oldest FROM jobs GROUP BY status,type')).rows,cases:(await this.pool.query('SELECT source_id,acquisition_status,count(*)::int AS count,min(last_observed_at) AS oldest_observation FROM cases GROUP BY source_id,acquisition_status')).rows,artifacts:(await this.pool.query('SELECT count(*)::int AS count,coalesce(sum(size_bytes),0)::text AS bytes FROM artifacts')).rows[0],sources:(await this.pool.query('SELECT id,enabled,health,paused_until FROM sources')).rows};}
  async verifyStorage():Promise<unknown>{
    const artifacts=await this.pool.query<{id:string;storage_key:string;sha256:string}>('SELECT id,storage_key,sha256 FROM artifacts');const failures:Record<string,string>[]=[];
    for(const artifact of artifacts.rows){try{const bytes=await this.store.get(artifact.storage_key);if(sha256(bytes)!==artifact.sha256)throw new Error('Checksum mismatch');}catch(error){failures.push({artifactId:artifact.id,error:error instanceof Error?error.message:String(error)});}}
    return {checked:artifacts.rows.length,valid:artifacts.rows.length-failures.length,failures};
  }
  async ingestObservation(observation:CaseObservation){return reconcileObservation(this.pool,observation);}

  async executeJob(job:Job,signal?:AbortSignal):Promise<{status:'complete'|'partial';result:Record<string,unknown>}>{
    signal?.throwIfAborted();
    if(job.type==='retention'){
      const result=await processRetentionRequest(this.pool,this.store,id.parse(job.payload['requestId']),client=>this.fence(client,job));
      if(result.lastErrorCode==='artifact_delete_failed')throw new SourceError('retryable','Artifact deletion interrupted');
      return {status:result.status==='complete'?'complete':'partial',result:{requestId:result.id,status:result.status,lastErrorCode:result.lastErrorCode}};
    }
    if(job.type==='interpret_case'){
      const config=caseInterpretationConfigFromEnv();if(!config)throw new SourceError('unsupported','Case inference is disabled');
      const result=await interpretCase(this.pool,id.parse(job.payload['caseId']),config,`${job.id}:${job.retryGeneration}`,client=>this.fence(client,job));
      if(result.status!=='complete')throw new SourceError('unsupported','Case inference is disabled');
      return {status:'complete',result:{runId:result.id}};
    }
    const context={...(signal?{signal}:{}),...(job.sourceId?{beforeRequest:async()=>{await this.reserveSourceRequest(job.sourceId!,signal);await this.liveBudget?.beforeRequest();}}:{}),...(this.liveBudget?{recordBytes:(bytes:number)=>this.liveBudget!.recordBytes(bytes),reserveDocument:()=>this.liveBudget!.reserveDocument()}:{})};
    if(job.type==='refresh_request'){
      const caseId=id.parse(job.payload['caseId']);
      const child=await transaction(this.pool,async client=>{
        await this.fence(client,job);
        const refresh=await this.enqueueCaseRefresh(client,caseId,`manual-refresh:${job.id}`,await readRefreshPolicy(client),job.id);
        await client.query('INSERT INTO job_links(parent_id,child_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[job.id,refresh.id]);
        return refresh;
      });
      return {status:'complete',result:{caseId,childJobIds:[child.id],completionScope:'refresh request; workflowStatus includes acquisition and processing'}};
    }
    if(job.type==='source_search'){
      const query=this.adapter(CourtSearchQuerySchema.parse(job.payload['query']).sourceId).validateSearch(job.payload['query']);
      const partitionId=typeof job.payload['partitionId']==='string'?job.payload['partitionId']:null;
      if(partitionId&&!(await this.pool.query('SELECT 1 FROM discovery_partitions WHERE id=$1 AND last_job_id=$2',[partitionId,job.id])).rowCount)
        throw new SourceError('permanent','Discovery job was superseded by an explicit partition generation');
      const observation=await this.adapter(query.sourceId).searchCases(query,context);
      if(observation.sourceId!==query.sourceId)throw new SourceError('parse_error','Search source identity mismatch');
      const children:string[]=[];
      const limitations=[...observation.limitations,...(observation.truncated?['Result limit reached']:[])];
      await transaction(this.pool,async client=>{
        await this.fence(client,job);
        if(partitionId&&!(await client.query('SELECT 1 FROM discovery_partitions WHERE id=$1 AND last_job_id=$2 FOR UPDATE',[partitionId,job.id])).rowCount)
          throw new SourceError('permanent','Discovery partition changed before checkpoint');
        const refreshPolicy=query.acquireResults===false?undefined:await readRefreshPolicy(client);
        for(const candidate of observation.cases){
          const row=(await client.query<{id:string;availability:string}>(`INSERT INTO cases(source_id,source_case_id,case_number,title,court,status,metadata)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id,source_case_id) DO UPDATE SET updated_at=now() RETURNING id,availability`,
          [query.sourceId,candidate.sourceCaseId,candidate.caseNumber,candidate.title,candidate.court,candidate.status,JSON.stringify({raw:candidate.raw})])).rows[0]!;
          if(refreshPolicy&&row.availability==='public'){
            const child=await this.enqueueCaseRefresh(client,row.id,`search:${job.id}:${row.id}`,refreshPolicy,job.id);
            await client.query('INSERT INTO job_links(parent_id,child_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[job.id,child.id]);
            children.push(child.id);
          }
        }
        await client.query(`INSERT INTO coverage_observations(source_id,partition_id,dimension,scope,observed_count,denominator,status,limitations,observed_at,job_id)
          VALUES($1,$2,'discovery',$3,$4,NULL,$5,$6,$7,$8) ON CONFLICT(job_id,dimension) DO UPDATE SET observed_count=EXCLUDED.observed_count,status=EXCLUDED.status,limitations=EXCLUDED.limitations,observed_at=EXCLUDED.observed_at`,
        [query.sourceId,partitionId,JSON.stringify(query),observation.cases.length,observation.truncated?'truncated':!observation.complete?'partial':'observed',JSON.stringify(limitations),observation.observedAt,job.id]);
        let split=false;
        if(partitionId&&observation.truncated&&query.filedFrom&&query.filedTo&&query.filedFrom<query.filedTo){
          const start=Date.parse(query.filedFrom),end=Date.parse(query.filedTo),day=86400000;
          const middle=start+Math.floor((end-start)/day/2)*day;
          for(const range of [{filedFrom:query.filedFrom,filedTo:new Date(middle).toISOString().slice(0,10)},{filedFrom:new Date(middle+day).toISOString().slice(0,10),filedTo:query.filedTo}]){
            const childQuery=this.adapter(query.sourceId).validateSearch({...query,...range});
            await client.query("INSERT INTO discovery_partitions(source_id,query,query_hash,status,parent_id,limitations,next_run_at) VALUES($1,$2,$3,'pending',$4,'[]',now()) ON CONFLICT(source_id,query_hash) DO NOTHING",[query.sourceId,JSON.stringify(childQuery),sha256(canonicalJson(childQuery)),partitionId]);
          }
          split=true;
        }
        if(partitionId)await client.query("UPDATE discovery_partitions SET status=$2,observed_count=$3,limitations=$4,recovery_count=0,last_error_code=NULL,next_run_at=CASE WHEN $2 IN ('split','saturated') THEN NULL ELSE now()+interval '1 day' END,updated_at=now() WHERE id=$1",
          [partitionId,split?'split':observation.truncated?'saturated':!observation.complete?'partial':'complete',observation.cases.length,JSON.stringify(limitations)]);
      });
      return {status:observation.truncated||!observation.complete?'partial':'complete',result:{observed:observation.cases.length,truncated:observation.truncated,coverage:'unknown',childJobIds:children,completionScope:'source observation only; workflowStatus includes acquisition and processing',limitations}};
    }
    if(job.type==='refresh_case'){
      if(!job.sourceId)throw new SourceError('permanent','Refresh has no source');
      const observation=await this.adapter(job.sourceId).fetchCase(z.string().parse(job.payload['sourceCaseId']),context);
      if(observation.sourceId!==job.sourceId)throw new SourceError('parse_error','Docket source identity mismatch');
      const saved=await reconcileObservation(this.pool,observation,client=>this.fence(client,job));const children:string[]=[];
      let budgetLimitedDocuments=0;
      for(const documentId of saved.documents){
        const child=await this.enqueueChild(job,{type:'download_artifact',sourceId:job.sourceId,payload:{documentId,caseId:saved.caseId},idempotencyKey:`snapshot:${saved.snapshotId}:${documentId}`});
        children.push(child.id);
      }
      await transaction(this.pool,async client=>{
        await this.fence(client,job);
        await scheduleNextRefresh(client,saved.caseId);
      });
      return {status:saved.complete&&!budgetLimitedDocuments?'complete':'partial',result:{caseId:saved.caseId,snapshotId:saved.snapshotId,acquisitionStatus:children.length||budgetLimitedDocuments?'partial':saved.complete?'complete':'partial',childJobIds:children,budgetLimitedDocuments}};
    }
    if(job.type==='download_artifact'){
      const documentId=id.parse(job.payload['documentId']);
      const row=(await this.pool.query<{reference:DocumentReference;case_id:string;source_id:string}>("SELECT d.reference,d.case_id,c.source_id FROM documents d JOIN cases c ON c.id=d.case_id WHERE d.id=$1 AND d.availability='available' AND c.availability='public'",[documentId])).rows[0];
      if(!row)throw new SourceError('restricted','Document no longer available');
      const artifact=await this.adapter(row.source_id).fetchDocument(row.reference,context);signal?.throwIfAborted();
      const versionId=await this.persistArtifact(documentId,artifact.bytes,artifact.filename,artifact.contentType,artifact.sourceUrl??null,artifact.acquiredAt,job);
      const processJob=await this.enqueueChild(job,{type:'process_document',payload:{documentVersionId:versionId,caseId:row.case_id},idempotencyKey:this.processingKey(versionId)});
      return {status:'complete',result:{documentVersionId:versionId,childJobIds:[processJob.id]}};
    }
    if(job.type==='process_document'){
      const versionId=id.parse(job.payload['documentVersionId']);
      const runKey=`${job.id}:${job.retryGeneration}`;
      const prior=(await this.pool.query<{status:'complete'|'partial';result:Record<string,unknown>}>('SELECT status,result FROM extraction_runs WHERE run_key=$1',[runKey])).rows[0];
      if(prior)return {status:prior.status,result:{documentVersionId:versionId,...prior.result}};
      const row=(await this.pool.query<{storage_key:string;filename:string}>("SELECT a.storage_key,dv.filename FROM document_versions dv JOIN artifacts a ON a.id=dv.artifact_id JOIN documents d ON d.id=dv.document_id JOIN cases c ON c.id=d.case_id WHERE dv.id=$1 AND c.availability='public' AND d.availability='available'",[versionId])).rows[0];
      if(!row)throw new SourceError('restricted','Document no longer available');
      const result=await processInWorker(await this.store.get(row.storage_key),{documentVersionId:versionId,filename:row.filename},signal);
      await transaction(this.pool,async client=>{
        await this.fence(client,job);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[versionId]);
        const available=await client.query("SELECT 1 FROM document_versions dv JOIN documents d ON d.id=dv.document_id JOIN cases c ON c.id=d.case_id WHERE dv.id=$1 AND c.availability='public' AND d.availability='available' FOR SHARE OF c,d",[versionId]);
        if(!available.rowCount)throw new SourceError('restricted','Document restricted during extraction');
        const run=(await client.query<{id:string}>(`INSERT INTO extraction_runs(document_version_id,pipeline_version,model,prompt_version,schema_version,status,result,started_at,finished_at,run_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,now(),now(),$8) ON CONFLICT(run_key) DO NOTHING RETURNING id`,
          [versionId,result.pipelineVersion,result.model??null,result.promptVersion??null,result.schemaVersion,result.status,JSON.stringify({classification:result.classification,warnings:result.warnings}),runKey])).rows[0];
        if(!run)return;
        for(const page of result.pages)await client.query('INSERT INTO pages(extraction_run_id,page_number,text,method,quality) VALUES($1,$2,$3,$4,$5)',[run.id,page.pageNumber,page.text,page.method,JSON.stringify(page.quality)]);
        for(const chunk of result.chunks)await client.query('INSERT INTO chunks(extraction_run_id,page_number,start_offset,end_offset,text) VALUES($1,$2,$3,$4,$5)',[run.id,chunk.pageNumber,chunk.startOffset,chunk.endOffset,chunk.text]);
        for(const entity of result.entities)await client.query('INSERT INTO entity_mentions(extraction_run_id,page_number,start_offset,end_offset,kind,value,confidence,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[run.id,entity.pageNumber,entity.startOffset,entity.endOffset,entity.kind,entity.value,entity.confidence,JSON.stringify(entity.data)]);
        for(const assertion of result.assertions)await client.query('INSERT INTO assertions(extraction_run_id,kind,text,evidence,confidence,data) VALUES($1,$2,$3,$4,$5,$6)',[run.id,assertion.kind,assertion.text,JSON.stringify(assertion.evidence),assertion.confidence,JSON.stringify(assertion.data)]);
      });
      return {status:result.status,result:{documentVersionId:versionId,pages:result.pages.length,classification:result.classification,warnings:result.warnings}};
    }
    if(job.type==='bulk_search'){
      const rows=z.array(z.object({index:z.number(),query:z.unknown().optional(),error:z.string().optional()})).parse(job.payload['queries']);const results:Record<string,unknown>[]=[];
      for(const row of rows){
        signal?.throwIfAborted();
        if(row.error){results.push({index:row.index,error:row.error});continue;}
        const query=CourtSearchQuerySchema.parse(row.query);
        const child=await this.enqueueChild(job,{type:'source_search',sourceId:query.sourceId,payload:{query},idempotencyKey:`bulk:${job.id}:${row.index}`});
        results.push({index:row.index,jobId:child.id,status:child.status});
      }
      return {status:rows.some(row=>row.error)?'partial':'complete',result:{items:results,completionScope:'submission; workflowStatus includes descendants'}};
    }
    if(job.type==='verify_artifact'){
      const result=objectSchema.parse(await this.verifyStorage());
      return {status:Array.isArray(result['failures'])&&result['failures'].length?'partial':'complete',result};
    }
    if(job.type==='recompute_coverage')return {status:'complete',result:await this.recomputeCoverage(job)};
    throw new SourceError('permanent',`Unsupported job type: ${job.type}`);
  }
  private processingKey(versionId:string):string{
    const configuration={pipeline:'poppler-tesseract-4',schema:'3',llm:process.env['COURT_LLM_ENABLED']==='true',
      provider:process.env['COURT_LLM_PROVIDER'],model:process.env['COURT_LLM_MODEL']};
    return `process:${versionId}:${sha256(canonicalJson(configuration))}`;
  }
  private async recomputeCoverage(job:Job):Promise<Record<string,unknown>>{
    return transaction(this.pool,async client=>{
      await this.fence(client,job);
      const rows=await client.query<{source_id:string;observed:string;acquired:string;available:string;entries:string}>(`SELECT s.id AS source_id,
        (SELECT count(*) FROM cases c WHERE c.source_id=s.id AND c.availability='public') AS observed,
        (SELECT count(*) FROM documents d JOIN cases c ON c.id=d.case_id WHERE c.source_id=s.id AND c.availability='public' AND d.availability='available') AS available,
        (SELECT count(*) FROM documents d JOIN cases c ON c.id=d.case_id WHERE c.source_id=s.id AND c.availability='public' AND d.availability='available' AND d.acquisition_status='complete') AS acquired,
        (SELECT count(*) FROM docket_entries e JOIN cases c ON c.id=e.case_id WHERE c.source_id=s.id AND c.availability='public' AND e.availability='public') AS entries FROM sources s`);
      for(const row of rows.rows){
        for(const dimension of [{name:'known_cases',count:row.observed,denominator:null},{name:'observed_docket_entries',count:row.entries,denominator:null},{name:'artifact_acquisition',count:row.acquired,denominator:row.available}]){
          await client.query(`INSERT INTO coverage_observations(source_id,dimension,scope,observed_count,denominator,status,limitations,job_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(job_id,dimension) DO UPDATE SET observed_count=EXCLUDED.observed_count,denominator=EXCLUDED.denominator,status=EXCLUDED.status,observed_at=now()`,
          [row.source_id,`${dimension.name}:${row.source_id}`,JSON.stringify({population:'currently public locally observed records'}),dimension.count,dimension.denominator,
            dimension.denominator===null?'observed':dimension.count===dimension.denominator?'complete':'partial',JSON.stringify([PUBLIC_NOTE]),job.id]);
        }
      }
      return {sources:rows.rows.length,coverage:'unknown outside observed population'};
    });
  }

  async persistArtifact(documentId:string,bytes:Buffer,filename:string,contentType:string,sourceUrl:string|null,acquiredAt:string,job?:Job):Promise<string>{
    await validatePdf(bytes,contentType);
    return withArtifactWriteLease(this.pool,async client=>{
      if(job)await this.fence(client,job);
      const doc=(await client.query<{case_id:string}>("SELECT d.case_id FROM documents d JOIN cases c ON c.id=d.case_id WHERE d.id=$1 AND d.availability='available' AND c.availability='public' FOR UPDATE OF c,d",[documentId])).rows[0];
      if(!doc)throw new SourceError('restricted','Document unavailable before checkpoint');
      const stored=await this.store.put(bytes);
      const artifact=(await client.query<{id:string}>('INSERT INTO artifacts(sha256,size_bytes,content_type,storage_key) VALUES($1,$2,$3,$4) ON CONFLICT(sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id',[stored.sha256,stored.sizeBytes,contentType,stored.storageKey])).rows[0]!;
      const version=(await client.query<{id:string}>('INSERT INTO document_versions(document_id,artifact_id,filename,source_url,acquired_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(document_id,artifact_id) DO UPDATE SET document_id=EXCLUDED.document_id RETURNING id',[documentId,artifact.id,path.basename(filename),sourceUrl,acquiredAt])).rows[0]!;
      await client.query(`UPDATE documents SET acquisition_status='complete',current_version_id=$2,current_observed_at=$3,updated_at=now(),last_verified_at=clock_timestamp(),
        next_revalidation_at=clock_timestamp()+(SELECT s.artifact_revalidation_hours*interval '1 hour' FROM cases c JOIN sources s ON s.id=c.source_id WHERE c.id=documents.case_id)
        WHERE id=$1 AND (current_observed_at IS NULL OR current_observed_at<=$3::timestamptz)`,[documentId,version.id,acquiredAt]);
      await client.query("INSERT INTO artifact_acquisition_attempts(document_id,artifact_id,outcome,observed_at,details) VALUES($1,$2,'complete',$3,$4)",[documentId,artifact.id,acquiredAt,JSON.stringify({jobId:job?.id??null})]);
      await client.query("UPDATE cases SET acquisition_status=CASE WHEN NOT EXISTS(SELECT 1 FROM documents WHERE case_id=$1 AND availability='available' AND acquisition_status<>'complete') AND (SELECT complete FROM docket_snapshots WHERE case_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1) THEN 'complete' ELSE 'partial' END WHERE id=$1",[doc.case_id]);
      return version.id;
    });
  }
  async importLegacy(directory:string):Promise<unknown>{
    const root=await realpath(directory);const manifests:string[]=[];
    async function scan(dir:string):Promise<void>{for(const item of await readdir(dir,{withFileTypes:true})){if(item.isSymbolicLink())continue;const p=path.join(dir,item.name);if(item.isDirectory())await scan(p);else if(item.name==='docket-export-index.json')manifests.push(p);}}
    await scan(root);const results:Record<string,unknown>[]=[];
    for(const manifestPath of manifests){
      try{
        const m=objectSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));const caseNumber=z.string().min(1).parse(m['caseNumber']);
        const docs=z.array(objectSchema).parse(m['documents']??m['downloaded']??[]);
        const events=Array.isArray(m['events'])?z.array(objectSchema).parse(m['events']):docs;
        const fullManifest=Array.isArray(m['events']);
        const completeDocket=fullManifest&&(m['snapshotComplete']===true||
          (m['schemaVersion']==='3.0.0'&&Array.isArray(m['ambiguities'])&&m['ambiguities'].length===0));
        const observation:CaseObservation={
          sourceId:'mn-mcro',sourceCaseId:caseNumber,caseNumber,title:String(m['caseTitle']??''),court:String(m['caseLocation']??''),
          status:String(m['caseStatus']??'unknown'),observedAt:String(m['finishedAt']??m['startedAt']??new Date().toISOString()),
          complete:completeDocket,participants:z.array(objectSchema).safeParse(m['parties']).data??[],
          sections:{...objectSchema.safeParse(m['sections']).data,legacyManifest:m},
          raw:{imported:true,legacyFullManifest:fullManifest,legacyPath:manifestPath,caseType:m['caseType'],filedDate:m['dateFiled']},
          entries:events.map((event,index)=>{
            const entryKey=fullManifest?eventIdentity({
              sourceId:typeof event['sourceId']==='string'?event['sourceId']:undefined,
              indexText:typeof event['indexText']==='string'?event['indexText']:undefined,
              date:typeof event['date']==='string'?event['date']:undefined,
              description:typeof event['description']==='string'?event['description']:undefined,
            }):`legacy:${String(event['documentKey']??sha256(String(event['filename'])))}`;
            const keys=Array.isArray(event['documentKeys'])?z.array(z.string()).parse(event['documentKeys']):null;
            const matching=docs.filter(doc=>doc===event||(keys&&typeof doc['documentKey']==='string'&&keys.includes(doc['documentKey']))||
              (typeof doc['documentKey']==='string'&&doc['documentKey']===event['documentKey'])||
              (!keys&&typeof doc['index']==='number'&&doc['index']===event['index']));
            const references=keys?keys.map(key=>matching.find(doc=>doc['documentKey']===key)??{documentKey:key}):matching;
            return {identityKey:entryKey,sourceOrder:index,date:String(event['date']??''),title:String(event['description']??''),
              identityConfidence:'derived',raw:{...event,legacyFullManifest:fullManifest},documents:references.map(doc=>({
                sourceDocumentId:String(doc['documentKey']??sha256(String(doc['filename']))),entryKey,caseNumber,
                title:String(doc['description']??event['description']??''),...(typeof doc['filename']==='string'?{filename:doc['filename']}:{}),
                availability:'available',raw:{legacy:true,legacyFullManifest:fullManifest,
                  sourceIdentityVerified:fullManifest&&typeof doc['sourceDocumentId']==='string'&&doc['sourceDocumentId']!==''},
              }))};
          }),
        };
        const saved=await this.ingestObservation(observation);let acquired=0;
        for(const doc of docs){const filename=z.string().min(1).parse(doc['filename']);if(path.basename(filename)!==filename)throw new Error('Unsafe legacy filename');const file=await realpath(path.join(path.dirname(manifestPath),filename));if(!file.startsWith(root+path.sep))throw new Error('Legacy artifact escapes import root');const bytes=await readFile(file);if(doc['sha256']&&sha256(bytes)!==doc['sha256'])throw new Error(`Legacy checksum mismatch: ${filename}`);
          const sourceDocumentId=String(doc['documentKey']??sha256(filename));const row=(await this.pool.query<{id:string}>('SELECT id FROM documents WHERE case_id=$1 AND source_document_id=$2',[saved.caseId,sourceDocumentId])).rows[0];if(!row)throw new Error('Legacy document association missing');
          const version=await this.persistArtifact(row.id,bytes,filename,'application/pdf',null,observation.observedAt);await this.jobs.enqueue({type:'process_document',payload:{documentVersionId:version,caseId:saved.caseId},idempotencyKey:this.processingKey(version)});acquired++;
        }
        results.push({caseId:saved.caseId,caseNumber,acquired,docketComplete:observation.complete});
      }catch(error){results.push({manifest:manifestPath,error:error instanceof Error?error.message:String(error)});}
    }
    return {manifests:manifests.length,results,status:results.some(row=>row['error'])?'partial':'complete'};
  }
}
