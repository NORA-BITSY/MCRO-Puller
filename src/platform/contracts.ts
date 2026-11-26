import { z } from 'zod';

const text = z.string().trim().min(1).max(500);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, 'Invalid calendar date');
export const CourtSearchQuerySchema = z.strictObject({
  sourceId: text.default('mn-mcro'),
  searchType: z.enum(['case', 'party', 'business', 'attorney', 'hearing', 'judgment', 'document']),
  caseNumber: text.optional(), citationNumber: text.optional(),
  lastName: text.optional(), firstName: text.optional(), middleName: text.optional(),
  businessName: text.optional(), attorneyLastName: text.optional(),
  attorneyFirstName: text.optional(), attorneyMiddleName: text.optional(),
  barNumber: text.optional(), judgeName: text.optional(), soundex: z.boolean().optional(),
  county: text.optional(), counties: z.array(text).max(100).optional(),
  categories: z.array(text).max(100).optional(), status: text.optional(),
  filedFrom: date.optional(), filedTo: date.optional(), hearingFrom: date.optional(),
  hearingTo: date.optional(), dobFrom: date.optional(), dobTo: date.optional(),
  docketedFrom: date.optional(), docketedTo: date.optional(), judgmentStatus: text.optional(),
  acquireResults: z.boolean().optional(),
}).superRefine((q, ctx) => {
  for (const [start, end] of [[q.filedFrom,q.filedTo],[q.hearingFrom,q.hearingTo],[q.dobFrom,q.dobTo],[q.docketedFrom,q.docketedTo]]) {
    if (start && end && start > end) ctx.addIssue({code:'custom',message:'Date range starts after its end'});
  }
});
export type CourtSearchQuery = z.infer<typeof CourtSearchQuerySchema>;
export interface SourceMetadata {id:string;state:string;name:string;baseUrl:string;adapterVersion:string;fixture:boolean;processOptInEnvironment?:string}
export interface SourceCapabilities {
  searchModes: Record<string,{required:string[];optional:string[];verified:'fixture'|'documented'|'live';limitations:string[]}>;
  resultLimit:number|null;exhaustiveDiscovery:boolean;notes:string[];
}
export interface CaseCandidate {sourceCaseId:string;caseNumber:string;title:string;court:string;status:string;raw:Record<string,unknown>}
export interface SearchObservation {
  sourceId:string;query:CourtSearchQuery;observedAt:string;cases:CaseCandidate[];
  truncated:boolean;complete:boolean;nextCursor?:string;limitations:string[];raw:Record<string,unknown>;
}
export interface DocumentReference {
  sourceDocumentId:string;entryKey:string;caseNumber:string;title:string;url?:string;filename?:string;
  revision?:string;
  availability:'available'|'restricted'|'unavailable'|'unknown';raw:Record<string,unknown>;
}
export interface DocketEntry {
  identityKey:string;sourceId?:string;sourceOrder:number;date:string|null;title:string;
  documents:DocumentReference[];raw:Record<string,unknown>;identityConfidence:'source'|'derived'|'ambiguous';
}
export interface CaseObservation {
  sourceId:string;sourceCaseId:string;caseNumber:string;title:string;court:string;status:string;
  observedAt:string;complete:boolean;entries:DocketEntry[];participants:Record<string,unknown>[];
  sections:Record<string,unknown>;raw:Record<string,unknown>;
}
export interface ArtifactObservation {bytes:Buffer;filename:string;contentType:string;sourceUrl?:string;acquiredAt:string}
export interface AcquisitionContext { signal?:AbortSignal; beforeRequest?:()=>Promise<void>; recordBytes?:(bytes:number)=>void; remainingBytes?:()=>number; reserveDocument?:()=>boolean }
export interface CourtSourceAdapter {
  metadata():SourceMetadata;
  capabilities():SourceCapabilities;
  validateSearch(query:unknown):CourtSearchQuery;
  searchCases(query:CourtSearchQuery,context:AcquisitionContext):Promise<SearchObservation>;
  fetchCase(identifier:string,context:AcquisitionContext):Promise<CaseObservation>;
  fetchDocument(reference:DocumentReference,context:AcquisitionContext):Promise<ArtifactObservation>;
  close():Promise<void>;
}
export type SourceErrorCode = 'blocked'|'restricted'|'not_found'|'retryable'|'permanent'|'parse_error'|'unsupported';
export class SourceError extends Error {
  readonly code:SourceErrorCode;
  readonly retryAfterMs:number|undefined;
  constructor(code:SourceErrorCode,message:string,options:{retryAfterMs?:number;cause?:unknown}={}) {
    super(message, {cause:options.cause});this.name='SourceError';this.code=code;this.retryAfterMs=options.retryAfterMs;
  }
}
export const QueryFiltersSchema = z.strictObject({
  sourceId:text.optional(),state:z.string().length(2).optional(),caseId:z.uuid().optional(),
  caseNumber:text.optional(),q:text.optional(),status:text.optional(),court:text.optional(),
  county:text.optional(),party:text.optional(),attorney:text.optional(),judge:text.optional(),
  category:text.optional(),filedFrom:date.optional(),filedTo:date.optional(),documentType:text.optional(),
  citation:text.optional(),organization:text.optional(),
  sortBy:z.enum(['observedAt','caseNumber','court','status','filedDate']).optional(),
  sortOrder:z.enum(['asc','desc']).optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50),
  offset:z.coerce.number().int().min(0).max(100000).default(0),
});
const domainErrorCodes=new Set(['blocked','restricted','not_found','retryable','permanent','parse_error','unsupported','conflict']);
const transientDriverCodes=new Set([
  'ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','ENETDOWN','EPIPE','EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET',
  '08000','08001','08003','08006','08007','40001','40P01','53300','55P03','57P01','57P02','57P03',
]);
export function errorInfo(error:unknown):{code:string;message:string;originalCode?:string;retryAfterMs?:number} {
  const message=error instanceof Error?error.message:String(error);
  let originalCode:string|undefined;
  let current:unknown=error;
  for(let depth=0;depth<5&&current instanceof Error;depth++){
    if('code' in current&&typeof current.code==='string'){originalCode=current.code;break;}
    current=current.cause;
  }
  if(error instanceof SourceError)return {code:error.code,message,...(error.retryAfterMs===undefined?{}:{retryAfterMs:error.retryAfterMs})};
  if(originalCode&&domainErrorCodes.has(originalCode))return {code:originalCode,message};
  return {code:originalCode&&transientDriverCodes.has(originalCode)?'retryable':'permanent',message,
    ...(originalCode?{originalCode}:{})};
}
