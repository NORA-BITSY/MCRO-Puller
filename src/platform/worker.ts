import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from './bootstrap.js';
import type { CourtService } from './service.js';
import { errorInfo } from './contracts.js';
import { transaction } from './database.js';
import { settleDiscoveryFailures } from './discovery.js';

export async function runOne(service:CourtService,workerId=`worker-${randomUUID()}`,shutdown?:AbortSignal):Promise<boolean>{
  const leaseMs=120000;
  const job=await service.jobs.claim(workerId,leaseMs);
  if(!job||!job.leaseToken)return false;
  const token=job.leaseToken;const controller=new AbortController();
  const cancel=()=>controller.abort();shutdown?.addEventListener('abort',cancel,{once:true});if(shutdown?.aborted)cancel();
  let renewing=false;
  const heartbeat=setInterval(()=>{
    if(renewing)return;renewing=true;
    void service.jobs.heartbeat(job.id,token,leaseMs).then(alive=>{if(!alive)controller.abort();}).catch(()=>controller.abort()).finally(()=>{renewing=false;});
  },20000);
  try{
    const result=await service.executeJob(job,controller.signal);
    controller.signal.throwIfAborted();
    const committed=await service.jobs.complete(job.id,token,result.result,result.status);
    if(!committed)throw new Error('Lease lost before completion');
    console.log(JSON.stringify({event:'job_completed',jobId:job.id,type:job.type,status:result.status,at:new Date().toISOString()}));
  }catch(error){
    const info=errorInfo(error);
    if(controller.signal.aborted)info.code='retryable';
    await transaction(service.pool,async client=>{
      const committed=await service.jobs.fail(job.id,token,info,client);
      if(!committed)return;
      if(job.type==='source_search')await settleDiscoveryFailures(client,job.id);
      if(job.type==='download_artifact'&&typeof job.payload['documentId']==='string'){
        await client.query(`UPDATE documents SET
          acquisition_status=CASE WHEN $4='restricted' THEN 'restricted' ELSE 'partial' END,
          availability=CASE WHEN $4='restricted' THEN 'restricted' WHEN $4='not_found' THEN 'unavailable' ELSE availability END
          WHERE id=$1 AND availability='available'
          AND EXISTS(SELECT 1 FROM jobs WHERE id=$2 AND attempts=$3 AND status<>'running')`,
        [job.payload['documentId'],job.id,job.attempts,info.code]);
        await client.query("INSERT INTO artifact_acquisition_attempts(document_id,outcome,observed_at,details) VALUES($1,$2,now(),$3)",
          [job.payload['documentId'],info.code,JSON.stringify({jobId:job.id,error:info.message})]);
        if(typeof job.payload['caseId']==='string')await client.query("UPDATE cases SET acquisition_status='partial' WHERE id=$1",[job.payload['caseId']]);
      }
      if(job.type==='refresh_case'&&typeof job.payload['caseId']==='string'){
        if(info.code==='restricted'){
          await client.query("UPDATE cases SET availability='restricted',acquisition_status='restricted' WHERE id=$1",[job.payload['caseId']]);
          await client.query("UPDATE documents SET availability='restricted' WHERE case_id=$1",[job.payload['caseId']]);
        }else{
          await client.query(`UPDATE cases SET next_refresh_at=CASE WHEN $3 IN ('retryable','lease_expired') THEN now()+interval '6 hours' ELSE NULL END,acquisition_status='partial'
            WHERE id=$1 AND availability='public' AND EXISTS(SELECT 1 FROM jobs WHERE id=$2 AND status='dead_letter')`,
          [job.payload['caseId'],job.id,info.code]);
        }
      }
    });
    console.error(JSON.stringify({event:'job_failed',jobId:job.id,type:job.type,...info,at:new Date().toISOString()}));
  }finally{clearInterval(heartbeat);shutdown?.removeEventListener('abort',cancel);}
  return true;
}
export async function runWorker():Promise<void>{
  const app=await createApplication();const controller=new AbortController();const stop=()=>controller.abort();
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const once=process.argv.includes('--once');const drain=process.argv.includes('--drain');
  const workerId=process.env.COURT_WORKER_ID??`worker-${randomUUID()}`;
  let nextSchedule=0;
  try{
    while(!controller.signal.aborted){
      if(Date.now()>=nextSchedule){await app.service.scheduleDue();nextSchedule=Date.now()+60000;}
      const worked=await runOne(app.service,workerId,controller.signal);
      if(once||drain&&!worked)break;
      if(!worked)await delay(1000,undefined,{signal:controller.signal}).catch(error=>{if(!controller.signal.aborted)throw error;});
    }
  }finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await app.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runWorker().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
