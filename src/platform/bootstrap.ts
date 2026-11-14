import { createDatabase } from './database.js';
import { createAdapters } from './adapters.js';
import { LocalArtifactStore,GcsArtifactStore } from './storage.js';
import { CourtService } from './service.js';
export async function createApplication():Promise<{service:CourtService;close:()=>Promise<void>}>{
  const url=process.env.COURT_DATABASE_URL;
  if(!url)throw new Error('COURT_DATABASE_URL is required; run courtctl db migrate before starting services');
  const pool=createDatabase(url);
  const mode=process.env.COURT_BROWSER_MODE??'standalone';
  if(mode!=='standalone'&&mode!=='extension')throw new Error('COURT_BROWSER_MODE must be standalone or extension');
  const adapters=createAdapters({mode,...(process.env.COURT_FIXTURE_PATH?{fixturePath:process.env.COURT_FIXTURE_PATH}:{})});
  const store=process.env.COURT_GCS_BUCKET?new GcsArtifactStore(process.env.COURT_GCS_BUCKET):new LocalArtifactStore(process.env.COURT_STORAGE_DIR??'.runtime/artifacts');
  const service=new CourtService(pool,store,adapters);
  try{await service.registerSources();}catch(error){await pool.end();throw error;}
  return {service,close:async()=>{await Promise.allSettled([...adapters.values()].map(adapter=>adapter.close()));await pool.end();}};
}
