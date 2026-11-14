import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { SourceError } from './contracts.js';

const activeMinutes = z.number().int().min(1).max(1440);
const dormantMinutes = z.number().int().min(1).max(525600);
export const RefreshPolicySchema = z.object({
  watchedMinutes: activeMinutes,
  newMinutes: activeMinutes,
  recentMinutes: activeMinutes,
  activeMinutes,
  inactiveMinutes: dormantMinutes,
  closedMinutes: dormantMinutes,
  partialMinutes: activeMinutes,
  failedMinutes: activeMinutes,
  newWindowDays: z.number().int().min(1).max(365),
  recentWindowDays: z.number().int().min(1).max(365),
}).strict();
export const RefreshPolicyPatchSchema = RefreshPolicySchema.partial();
export type RefreshPolicy = z.infer<typeof RefreshPolicySchema>;
export const defaultRefreshPolicy: RefreshPolicy = {
  watchedMinutes: 60, newMinutes: 360, recentMinutes: 720, activeMinutes: 1440,
  inactiveMinutes: 10080, closedMinutes: 43200, partialMinutes: 120, failedMinutes: 360,
  newWindowDays: 7, recentWindowDays: 30,
};
export type RefreshClass = 'watched' | 'new' | 'recent' | 'active' | 'inactive' | 'closed' | 'partial' | 'failed';
export interface RefreshEvidence {
  created_at: Date;
  status: string;
  watched: boolean;
  latest_complete: boolean | null;
  last_meaningful_activity_at: Date | null;
  latest_refresh_status: string | null;
}
export interface RefreshDecision {
  refreshClass: RefreshClass;
  intervalMinutes: number;
  priority: number;
}

/** Unknown source-specific status labels remain active; no cross-portal taxonomy is inferred. */
export function refreshDecision(evidence: RefreshEvidence, policy: RefreshPolicy, now = new Date()): RefreshDecision {
  let refreshClass: RefreshClass;
  const status = evidence.status.trim().toLowerCase();
  if (evidence.watched) refreshClass = 'watched';
  else if (evidence.latest_refresh_status === 'dead_letter') refreshClass = 'failed';
  else if (evidence.latest_complete === false || evidence.latest_refresh_status === 'partial') refreshClass = 'partial';
  else if (status === 'closed' || status === 'disposed') refreshClass = 'closed';
  else if (status === 'inactive') refreshClass = 'inactive';
  else if (evidence.created_at.getTime() > now.getTime() - policy.newWindowDays * 86_400_000) refreshClass = 'new';
  else if (evidence.last_meaningful_activity_at && evidence.last_meaningful_activity_at.getTime() > now.getTime() - policy.recentWindowDays * 86_400_000) refreshClass = 'recent';
  else refreshClass = 'active';
  return { refreshClass, intervalMinutes: policy[`${refreshClass}Minutes`], priority: evidence.watched ? 100 : 0 };
}

export async function readRefreshPolicy(database: Pool | PoolClient): Promise<RefreshPolicy> {
  const row = (await database.query<{ policy: unknown }>('SELECT policy FROM refresh_policy WHERE singleton=true')).rows[0];
  return RefreshPolicySchema.parse(row?.policy);
}

export async function caseRefreshDecision(client: PoolClient, caseId: string, policy: RefreshPolicy): Promise<RefreshDecision> {
  const evidence = (await client.query<RefreshEvidence>(`SELECT c.created_at,c.status,c.watched,e.latest_complete,e.last_meaningful_activity_at,
    (SELECT j.status FROM jobs j WHERE j.type='refresh_case' AND j.payload->>'caseId'=c.id::text ORDER BY j.created_at DESC,j.id DESC LIMIT 1) AS latest_refresh_status
    FROM cases c JOIN case_refresh_evidence e ON e.case_id=c.id WHERE c.id=$1 AND c.availability='public' FOR UPDATE OF c`, [caseId])).rows[0];
  if (!evidence) throw new SourceError('not_found', 'Case not found or restricted');
  return refreshDecision(evidence, policy);
}

export async function scheduleNextRefresh(client: PoolClient, caseId: string, policy?: RefreshPolicy): Promise<RefreshDecision> {
  const decision = await caseRefreshDecision(client, caseId, policy ?? await readRefreshPolicy(client));
  await client.query(`UPDATE cases SET next_refresh_at=clock_timestamp()+($2::integer*interval '1 minute'),refresh_class=$3,refresh_interval_minutes=$2 WHERE id=$1`,
    [caseId, decision.intervalMinutes, decision.refreshClass]);
  return decision;
}
