import { createHash } from 'node:crypto';

export interface EventIdentityInput {
  sourceId?: string | undefined;
  indexText?: string | undefined;
  date?: string | undefined;
  description?: string | undefined;
}

/** Source event IDs take precedence; derived identities never include DOM order. */
export function eventIdentity(event: EventIdentityInput): string {
  return event.sourceId || createHash('sha256')
    .update(JSON.stringify([event.indexText, event.date, event.description]))
    .digest('hex');
}
