import { Worker } from 'node:worker_threads';
import type { ProcessingResult } from './processing.js';
export async function processInWorker(bytes:Buffer,meta:{documentVersionId:string;filename:string},signal?:AbortSignal):Promise<ProcessingResult>{
  signal?.throwIfAborted();
  const suffix=import.meta.url.endsWith('.ts')?'ts':'js';
  const worker=new Worker(new URL(`./processing-thread.${suffix}`,import.meta.url),{workerData:{bytes,meta},resourceLimits:{maxOldGenerationSizeMb:512}});
  const {promise,resolve,reject}=Promise.withResolvers<ProcessingResult>();
  let settled=false;
  const finish=(error:Error|null,result?:ProcessingResult)=>{
    if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();
    if(error)reject(error);else if(result)resolve(result);else reject(new Error('Processing worker returned no result'));
  };
  const abort=()=>finish(new Error('Processing cancelled'));
  const timer=setTimeout(()=>finish(new Error('Document processing exceeded 15-minute limit')),900000);
  worker.once('message',(message:{result?:ProcessingResult;error?:string})=>finish(message.error?new Error(message.error):null,message.result));
  worker.once('error',error=>finish(error instanceof Error?error:new Error(String(error))));
  worker.once('exit',code=>{if(!settled)finish(new Error(`Processing worker exited before result (${code})`));});
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  return promise;
}
