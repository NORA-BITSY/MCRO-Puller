import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink, readFile, mkdtemp, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runNative } from '../native-tools.js';
import { Storage } from '@google-cloud/storage';
export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export interface StoredArtifact {sha256:string;sizeBytes:number;storageKey:string}
export interface ArtifactStore {put(bytes:Buffer):Promise<StoredArtifact>;get(key:string):Promise<Buffer>;remove(key:string):Promise<void>}
export const sha256=(bytes:Buffer|string):string=>createHash('sha256').update(bytes).digest('hex');
function keyHash(key:string):string {
  if(!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new Error('Invalid artifact key');
  const hash=key.split('/')[2];
  if(!hash || key.split('/')[1]!==hash.slice(0,2)) throw new Error('Invalid artifact key');
  return hash;
}
function descriptor(bytes:Buffer):StoredArtifact {
  if(bytes.length===0 || bytes.length>MAX_ARTIFACT_BYTES) throw new Error('Artifact size outside supported bounds');
  const hash=sha256(bytes);return {sha256:hash,sizeBytes:bytes.length,storageKey:`sha256/${hash.slice(0,2)}/${hash}`};
}
export class LocalArtifactStore implements ArtifactStore {
  constructor(readonly root:string) {}
  async put(bytes:Buffer):Promise<StoredArtifact> {
    const item=descriptor(bytes);const target=path.join(this.root,item.storageKey);
    await mkdir(path.dirname(target),{recursive:true,mode:0o700});
    const temp=`${target}.${randomUUID()}.tmp`;
    const file=await open(temp,'wx',0o600);
    try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
    try {await link(temp,target);} catch(error) {
      if(!(error instanceof Error && 'code' in error && error.code==='EEXIST')) throw error;
    } finally {await unlink(temp);}
    await this.get(item.storageKey);return item;
  }
  async get(key:string):Promise<Buffer> {
    const expected=keyHash(key);const target=path.join(this.root,key);const stat=await lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_ARTIFACT_BYTES)throw new Error('Invalid artifact file');
    const bytes=await readFile(target);
    if(sha256(bytes)!==expected)throw new Error(`Artifact checksum mismatch: ${key}`);
    return bytes;
  }
  async remove(key:string):Promise<void> {keyHash(key);try{await unlink(path.join(this.root,key));}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}}
}
export class GcsArtifactStore implements ArtifactStore {
  private readonly storage=new Storage();
  constructor(readonly bucketName:string) {}
  async put(bytes:Buffer):Promise<StoredArtifact> {
    const item=descriptor(bytes);const file=this.storage.bucket(this.bucketName).file(item.storageKey);
    try {await file.save(bytes,{resumable:false,validation:'crc32c',preconditionOpts:{ifGenerationMatch:0},metadata:{metadata:{sha256:item.sha256}}});}
    catch(error){if(!(error instanceof Error && 'code' in error && error.code===412))throw error;}
    await this.get(item.storageKey);return item;
  }
  async get(key:string):Promise<Buffer> {
    const expected=keyHash(key);const file=this.storage.bucket(this.bucketName).file(key);
    const [metadata]=await file.getMetadata();
    if(Number(metadata.size)>MAX_ARTIFACT_BYTES)throw new Error('Artifact exceeds size limit');
    const [bytes]=await file.download({validation:'crc32c'});
    if(sha256(bytes)!==expected)throw new Error(`Artifact checksum mismatch: ${key}`);
    return bytes;
  }
  async remove(key:string):Promise<void>{keyHash(key);await this.storage.bucket(this.bucketName).file(key).delete({ignoreNotFound:true});}
}
export async function validatePdf(bytes:Buffer,contentType:string):Promise<{pages:number}> {
  descriptor(bytes);
  if(!/^application\/pdf(?:;|$)/i.test(contentType)||bytes.subarray(0,5).toString()!=='%PDF-')throw new Error('Invalid PDF content type or signature');
  const dir=await mkdtemp(path.join(os.tmpdir(),'court-pdf-'));
  try {
    const filename=path.join(dir,'source.pdf');await writeFile(filename,bytes,{mode:0o600});
    const {stdout,stderr}=await runNative('pdfinfo',[filename],{timeout:30000,maxBuffer:1024*1024});
    if(/Syntax Error/i.test(stderr))throw new Error(`PDF parser reported a syntax error: ${stderr}`);
    const pages=Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if(!Number.isSafeInteger(pages)||pages<1)throw new Error('PDF has no valid page tree');
    return {pages};
  }catch(error){throw new Error(`PDF structural validation failed: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
  finally {await rm(dir,{recursive:true,force:true});}
}
