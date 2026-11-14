#!/usr/bin/env node
// Synthetic Minnesota-shaped observations only. No live court transport exists
// in this harness; the production adapter is never enabled or navigated.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFile,writeFile,mkdtemp,rm,mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CourtService } from '../dist/src/platform/service.js';
import { MinnesotaAdapter,mapRoa } from '../dist/src/platform/adapters.js';
import { LocalArtifactStore } from '../dist/src/platform/storage.js';
import { runOne } from '../dist/src/platform/worker.js';
import { createApi } from '../dist/src/platform/api.js';
import { parseRoa } from '../dist/src/roa.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exec=promisify(execFile),caseNumber='27-CV-24-1';
const fixtureRoot=path.join(root,'test/fixtures/adapters');
process.env.COURT_ALLOW_LIVE_MN='false';process.env.COURT_LLM_ENABLED='false';process.env.COURT_CASE_INTERPRETATION_ENABLED='false';
let browser,networkAttempts=0;
class OfflineMinnesota extends MinnesotaAdapter{
  metadata(){const {processOptInEnvironment:_,...metadata}=super.metadata();return {...metadata,name:'Synthetic Minnesota offline acceptance',fixture:true,baseUrl:'fixture://mn-offline'};}
  async searchCases(query,context){
    this.validateSearch(query);await context.beforeRequest?.();
    const missing=query.lastName==='Missing';
    return {sourceId:'mn-mcro',query,observedAt:new Date().toISOString(),cases:missing?[]:[{sourceCaseId:caseNumber,caseNumber,title:'Synthetic Example',court:'Hennepin',status:'Active',raw:{fixture:true}}],truncated:false,complete:true,limitations:['Synthetic query response; not a live Minnesota search contract.'],raw:{fixture:true}};
  }
  async fetchCase(identifier,context){
    assert.equal(identifier,caseNumber);await context.beforeRequest?.();
    const systemChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser??=await chromium.launch({headless:true,...(existsSync(systemChrome)?{executablePath:systemChrome}:{})});
    const session=await browser.newContext({serviceWorkers:'block'});
    await session.route('**/*',route=>{networkAttempts++;return route.abort();});
    try{
      const page=await session.newPage();await page.setContent(await readFile(path.join(fixtureRoot,'mn-roa-observed.html'),'utf8'));
      const revision=process.env.MN_ACCEPT_REVISION??'initial';
      if(revision==='changed')await page.evaluate(()=>{
        const events=document.querySelector('#mpa-roa-case-events-content');events.prepend(events.lastElementChild);
        const added=document.createElement('div');added.className='mpa-case-details-party-item';added.dataset.eventId='synthetic-new';added.innerHTML='<span class="mpa-text-semi-bold">01/04/2024</span><span id="mpa-event-3">Status conference continued</span><div class="mpa-case-event-text-wrapper">Index #10</div>';events.append(added);
        document.querySelector('.mpa-document-title').textContent='Amended Petition';
      });
      const observation=mapRoa(await parseRoa(page));
      if(revision==='partial'){observation.complete=false;observation.entries=observation.entries.slice(0,1);}
      return observation;
    }finally{await session.close();}
  }
  async fetchDocument(reference,context){
    await context.beforeRequest?.();const changed=process.env.MN_ACCEPT_REVISION==='changed';
    const filename=reference.title==='Exhibit A'||changed?'exhibit.pdf':'petition.pdf';
    return {bytes:await readFile(path.join(fixtureRoot,filename)),filename,contentType:'application/pdf',sourceUrl:'fixture://mn-offline/'+filename,acquiredAt:new Date().toISOString()};
  }
  async close(){}
}
async function application(url,storage){const pool=new Pool({connectionString:url});const adapter=new OfflineMinnesota();const service=new CourtService(pool,new LocalArtifactStore(storage),new Map([['mn-mcro',adapter]]));await service.registerSources();return {pool,service};}
if(process.argv.includes('--worker')||process.argv.includes('--crash')){
  const app=await application(process.env.COURT_DATABASE_URL,process.env.COURT_STORAGE_DIR);
  try{
    if(process.argv.includes('--crash')){
      const job=await app.service.jobs.claim('mn-accept-crash');assert.equal(job.id,process.env.MN_ACCEPT_JOB_ID);
      await app.service.executeJob(job);console.log('CHECKPOINT_COMMITTED');await new Promise(()=>{});
    }else{let count=0;while(await runOne(app.service,'mn-accept-worker')){if(++count>100)throw Error('Acceptance workload exceeded bound');}assert.equal(networkAttempts,0);console.log(JSON.stringify({completedJobs:count,networkAttempts}));}
  }finally{await browser?.close();await app.pool.end();}
}else{
  assert.ok(process.env.COURT_TEST_DATABASE_URL,'COURT_TEST_DATABASE_URL must designate an isolated development database; never use production');
  const base=process.env.COURT_TEST_DATABASE_URL,schema='mn_accept_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:base});
  const directory=await mkdtemp(path.join(os.tmpdir(),'mn-accept-')),started=performance.now();
  const url=new URL(base);url.searchParams.set('options',`-c search_path=${schema},public`);
  const env={...process.env,COURT_DATABASE_URL:url.href,COURT_STORAGE_DIR:directory,COURT_GCS_BUCKET:'',API_TOKEN_READ:randomUUID(),API_TOKEN_WRITE:randomUUID(),API_TOKEN_ADMIN:randomUUID(),MCP_ROLE:'read'};
  let app,api,mcp;const workerReports=[];
  async function cli(...args){const result=await exec(process.execPath,['dist/src/platform/courtctl.js',...args],{cwd:root,env,maxBuffer:8*1024*1024});return JSON.parse(result.stdout);}
  async function drain(revision='initial'){const result=await exec(process.execPath,['scripts/accept-minnesota.mjs','--worker'],{cwd:root,env:{...env,MN_ACCEPT_REVISION:revision},timeout:120000,maxBuffer:8*1024*1024});process.stdout.write(result.stdout);process.stderr.write(result.stderr);const report=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(report.networkAttempts,0);workerReports.push(report);return report;}
  try{
    await admin.query(`CREATE SCHEMA "${schema}"`);await cli('db','migrate');app=await application(url.href,directory);
    const capabilities=await cli('source','caps','--state','MN');assert.equal(capabilities.exhaustiveDiscovery,false);
    const query={sourceId:'mn-mcro',searchType:'case',caseNumber};
    const acquired=await cli('acquire','--query',JSON.stringify(query),'--idempotency-key','mn-single');
    assert.equal((await cli('acquire','--query',JSON.stringify(query),'--idempotency-key','mn-single')).jobId,acquired.jobId);
    await cli('source','pause','--state','MN','--minutes','10','--reason','Offline acceptance pause');
    assert.equal((await drain()).completedJobs,0);assert.equal((await cli('jobs','status',acquired.jobId)).workflowStatus,'pending');
    await cli('source','resume','--state','MN','--reason','Offline acceptance resume');await drain();
    assert.equal((await cli('jobs','status',acquired.jobId)).workflowStatus,'complete',JSON.stringify((await app.pool.query('SELECT type,status,error FROM jobs')).rows));
    const cases=await cli('db','search','--state','MN');assert.equal(cases.data.length,1);const caseId=cases.data[0].id;
    const docket=await cli('case','docket',caseId);assert.equal(docket.data.length,2);assert.equal(docket.data.filter(entry=>entry.documents.length===0).length,1);
    const docs=docket.data.flatMap(entry=>entry.documents);assert.equal(docs.length,2);
    const initialIds=docket.data.map(entry=>entry.id).sort();
    for(const [field,value] of [['party','Jane Doe'],['attorney','Sam Counsel'],['judge','Alex Judge'],['organization','Example Entity']])assert.equal((await cli('db','search',`--${field}`,value)).data[0].id,caseId);
    assert.equal((await cli('db','search','--organization','Unlabeled Name')).data.length,0);
    const raw=(await app.pool.query('SELECT raw FROM docket_snapshots')).rows[0].raw;assert.ok(!JSON.stringify(raw).includes('secret-A'));assert.ok(raw.sections['mpa-roa-financials-content']);
    const mixed=[{...query,acquireResults:false},{sourceId:'mn-mcro',searchType:'party',lastName:'Doe',firstName:'Jane',acquireResults:false},{...query,county:'Hennepin'}];
    const files=[['json',JSON.stringify({queries:mixed})],['jsonl',mixed.map(value=>JSON.stringify(value)).join('\n')],['csv','sourceId,searchType,caseNumber,lastName,firstName,county,acquireResults\nmn-mcro,case,27-CV-24-1,,,,false\nmn-mcro,party,,Doe,Jane,,false\nmn-mcro,case,27-CV-24-1,,,Hennepin,false\n']];
    const batches=[];
    for(const [format,content] of files){const filename=path.join(directory,`batch.${format}`);await writeFile(filename,content);const batch=await cli('bulk','--file',filename,'--idempotency-key',`mn-${format}`);assert.deepEqual(batch.validation.map(item=>Boolean(item.valid)),[true,true,false]);batches.push(batch.jobId);}
    await drain();for(const batch of batches)assert.equal((await cli('jobs','status',batch)).workflowStatus,'partial');
    const missing=await cli('source','search','--query',JSON.stringify({sourceId:'mn-mcro',searchType:'party',lastName:'Missing',firstName:'Synthetic'}),'--idempotency-key','mn-no-result');await drain();assert.equal((await cli('jobs','status',missing.jobId)).result.observed,0);
    api=await createApi(app.service,{env});const address=await api.listen({host:'127.0.0.1',port:0});
    const headers={authorization:`Bearer ${env.API_TOKEN_READ}`};
    assert.equal((await fetch(address+'/api/v1/cases')).status,401);
    assert.equal((await fetch(address+'/api/v1/sources/mn-mcro/control',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({action:'disable',reason:'Unauthorized'})})).status,403);
    const cliText=await cli('db','filing-search','--state','MN','--q','petition');assert.equal(cliText.data.length,1);
    const httpText=await fetch(address+'/api/v1/filing-text?state=MN&q=petition',{headers});assert.equal(httpText.status,200);assert.deepEqual((await httpText.json()).data.map(row=>row.id),cliText.data.map(row=>row.id));
    mcp=new Client({name:'mn-offline-acceptance',version:'1'});await mcp.connect(new StdioClientTransport({command:process.execPath,args:['dist/src/platform/mcp.js'],cwd:root,env,stderr:'inherit'}));
    const tools=await mcp.listTools();assert.ok(!tools.tools.some(tool=>tool.name==='control_source'));
    const mcpText=await mcp.callTool({name:'search_filing_text',arguments:{state:'MN',q:'petition'}});assert.deepEqual(JSON.parse(mcpText.content[0].text).data.map(row=>row.id),cliText.data.map(row=>row.id));
    for(const doc of docs){assert.ok((await cli('document','text',doc.id)).data[0].text);const response=await fetch(address+`/api/v1/documents/${doc.id}/content`,{headers});assert.equal(response.status,200);assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,5).toString(),'%PDF-');}
    await app.pool.query("UPDATE cases SET next_refresh_at=clock_timestamp()-interval '1 second' WHERE id=$1",[caseId]);
    const scheduled=await cli('schedule','due');assert.ok(scheduled.scheduled>=1);await drain('changed');
    const changed=await cli('case','docket',caseId);assert.equal(changed.data.length,3);assert.ok(initialIds.every(id=>changed.data.some(entry=>entry.id===id)));
    assert.equal((await app.pool.query('SELECT count(*)::int AS n FROM document_versions')).rows[0].n,3);
    await cli('case','refresh',caseId,'--idempotency-key','mn-partial');await drain('partial');assert.equal((await cli('case','docket',caseId)).data.length,3);assert.equal((await cli('case','get',caseId)).acquisition_status,'partial');
    const version=(await app.pool.query('SELECT current_version_id AS id FROM documents WHERE current_version_id IS NOT NULL LIMIT 1')).rows[0].id;
    const crash=await app.service.jobs.enqueue({type:'process_document',payload:{documentVersionId:version,caseId},idempotencyKey:'mn-crash',priority:100});
    const child=spawn(process.execPath,['scripts/accept-minnesota.mjs','--crash'],{cwd:root,env:{...env,MN_ACCEPT_JOB_ID:crash.id},stdio:['ignore','pipe','inherit']});
    const ready=Promise.withResolvers();let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('CHECKPOINT_COMMITTED'))ready.resolve();});child.once('exit',(code,signal)=>{if(!output.includes('CHECKPOINT_COMMITTED'))ready.reject(Error(`Crash child exited ${code}/${signal}`));});
    await ready.promise;const exited=once(child,'exit');child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL');
    const checkpoint=(await app.pool.query('SELECT id FROM extraction_runs WHERE run_key=$1',[`${crash.id}:0`])).rows;
    await app.pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[crash.id]);await drain('partial');
    assert.deepEqual((await app.pool.query('SELECT id FROM extraction_runs WHERE run_key=$1',[`${crash.id}:0`])).rows,checkpoint);
    assert.deepEqual((await app.pool.query('SELECT status FROM job_attempts WHERE job_id=$1 ORDER BY attempt',[crash.id])).rows.map(row=>row.status),['expired','complete']);
    const integrity=await cli('storage','verify');assert.equal(integrity.failures.length,0);
    await cli('case','restrict',caseId,'--reason','Synthetic withdrawal acceptance');
    assert.equal((await cli('db','search','--state','MN')).data.length,0);
    assert.equal((await fetch(address+`/api/v1/documents/${docs[0].id}/content`,{headers})).status,404);
    assert.equal((await mcp.callTool({name:'get_case',arguments:{id:caseId}})).isError,true);
    const report={observedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),fixture:'synthetic Minnesota-shaped HTML parsed by production parseRoa/mapRoa',liveTraffic:0,initialDocketEntries:2,changedDocketEntries:3,attachments:2,retainedDocumentVersions:3,batchFormats:['json','jsonl','csv'],batchInvalidNeighborsPreserved:true,compiledCli:true,http:'actual authenticated loopback',mcp:'actual child-process stdio',recovery:'SIGKILL after committed processing; injected lease expiry; same extraction reused',workerReports,integrity,labels:{localApplication:'workflow passed',liveMinnesota:'NOT VERIFIED',cloudOperations:'NOT VERIFIED'}};
    await mkdir(path.join(root,'.runtime'),{recursive:true});await writeFile(path.join(root,'.runtime/minnesota-acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await mcp?.close();await api?.close();await app?.pool.end();await browser?.close();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();await rm(directory,{recursive:true,force:true});}
}
