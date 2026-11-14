import { parentPort,workerData } from 'node:worker_threads';
import { z } from 'zod';
import { processDocument,llmConfigFromEnv } from './processing.js';
const input=z.object({bytes:z.instanceof(Uint8Array),meta:z.object({documentVersionId:z.string(),filename:z.string()})}).parse(workerData);
try {
  const llm=llmConfigFromEnv();
  const result=await processDocument(Buffer.from(input.bytes),input.meta,llm?{llm}:{});
  parentPort?.postMessage({result});
}catch(error){parentPort?.postMessage({error:error instanceof Error?error.message:String(error)});}
