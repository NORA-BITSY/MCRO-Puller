import EmbeddedPostgres from 'embedded-postgres';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
const root=path.resolve('.runtime');
await mkdir(root,{recursive:true,mode:0o700});
const credentialFile=path.join(root,'database.json');
let credentials:{password:string;port:number};
try {credentials=JSON.parse(await readFile(credentialFile,'utf8')) as {password:string;port:number};}
catch(error){
  if(!(error instanceof Error && 'code' in error && error.code==='ENOENT'))throw error;
  credentials={password:randomBytes(24).toString('hex'),port:Number(process.env.COURT_DEV_DB_PORT||15439)};
  await writeFile(credentialFile,JSON.stringify(credentials),{mode:0o600,flag:'wx'});
}
const database=new EmbeddedPostgres({databaseDir:path.join(root,'postgres'),user:'court',password:credentials.password,port:credentials.port,persistent:true,authMethod:'scram-sha-256',postgresFlags:['-h','127.0.0.1','-k',root],onLog:()=>{},onError:message=>console.error(String(message))});
try { await access(path.join(root,'postgres','PG_VERSION')); }
catch(error){
  if(!(error instanceof Error && 'code' in error && error.code==='ENOENT'))throw error;
  await database.initialise();
}
await database.start();
const client=database.getPgClient();await client.connect();
if(!(await client.query("SELECT 1 FROM pg_database WHERE datname='court_dev'")).rowCount)await client.query('CREATE DATABASE court_dev');
await client.end();
const url=`postgresql://court:${credentials.password}@127.0.0.1:${credentials.port}/court_dev`;
await writeFile(path.join(root,'database.env'),`COURT_DATABASE_URL=${url}\nCOURT_TEST_DATABASE_URL=${url}\n`,{mode:0o600});
console.log(`Court development PostgreSQL ready on 127.0.0.1:${credentials.port}; credentials: .runtime/database.env`);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await database.stop();process.exit(0);}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
