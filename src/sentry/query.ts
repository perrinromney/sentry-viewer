import type { Issue, SentryEvent } from './types';

/**
 * Two-tier filter model:
 * - Server tier (status, assigned, tags, rawQuery) becomes a Sentry search
 *   query string — anything Sentry can index (tags + built-in tokens).
 * - Client tier (clientText, clientContexts, file) is applied locally against
 *   each issue's cached latest event, because Sentry cannot search structured
 *   contexts (vue.componentName, selection.session, …).
 */
export interface FilterState {
  status: 'unresolved' | 'ignored' | 'resolved' | 'all';
  rawQuery: string;
  serverTags: Record<string, string>;
  /** Sentry token value: 'me' | 'none' | user/team actor, appended as assigned:<value>. */
  assigned?: string;
  clientText: string;
  /** Dotted context path -> case-insensitive substring, e.g. { 'vue.componentName': 'Schedule' }. */
  clientContexts: Record<string, string>;
  /** Workspace fsPath; issues must have a frame resolving to this file (evaluated by the store). */
  file?: string;
}

export const DEFAULT_FILTER: FilterState = {
  status: 'unresolved',
  rawQuery: '',
  serverTags: {},
  clientText: '',
  clientContexts: {},
};

export function isDefaultFilter(f: FilterState): boolean {
  return (
    f.status === 'unresolved' &&
    !f.rawQuery &&
    !f.assigned &&
    !f.file &&
    Object.keys(f.serverTags).length === 0 &&
    !f.clientText &&
    Object.keys(f.clientContexts).length === 0
  );
}

function quoteValue(value: string): string {
  return /[\s:"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function buildServerQuery(f: FilterState): string {
  const parts: string[] = [];
  if (f.status !== 'all') parts.push(`is:${f.status}`);
  if (f.assigned) parts.push(`assigned:${f.assigned}`);
  for (const [key, value] of Object.entries(f.serverTags)) {
    if (value) parts.push(`${key}:${quoteValue(value)}`);
  }
  if (f.rawQuery.trim()) parts.push(f.rawQuery.trim());
  return parts.join(' ');
}

/** Read a dotted path from event contexts, falling back to the `extra` context bag. */
export function contextValue(event: SentryEvent, dottedPath: string): unknown {
  const segments = dottedPath.split('.');
  let node: unknown = event.contexts;
  for (const seg of segments) {
    if (node && typeof node === 'object' && seg in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[seg];
    } else {
      node = undefined;
      break;
    }
  }
  if (node !== undefined) return node;
  return event.context?.[dottedPath] ?? (segments.length === 1 ? event.context?.[segments[0]] : undefined);
}

function containsInsensitive(haystack: unknown, needle: string): boolean {
  if (haystack === null || haystack === undefined) return false;
  return String(haystack).toLowerCase().includes(needle.toLowerCase());
}

/**
 * Client-side predicate. Issues whose latest event has not been fetched yet
 * pass context filters optimistically (they are re-filtered once it lands),
 * so the list never flashes empty while events stream in.
 */
export function buildClientPredicate(f: FilterState): (issue: Issue, event?: SentryEvent) => boolean {
  const contextEntries = Object.entries(f.clientContexts).filter(([, v]) => v);
  const text = f.clientText.trim().toLowerCase();
  return (issue, event) => {
    if (text) {
      const hay = `${issue.title} ${issue.culprit} ${issue.metadata.value ?? ''} ${issue.shortId}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    if (contextEntries.length > 0) {
      if (!event) return true; // optimistic until the latest event is cached
      for (const [path, needle] of contextEntries) {
        if (!containsInsensitive(contextValue(event, path), needle)) return false;
      }
    }
    return true;
  };
}

/** Compact human summary for the tree view description, e.g. `is:unresolved · company:turner · vue.componentName~Sched`. */
export function describeFilter(f: FilterState): string {
  if (isDefaultFilter(f)) return '';
  const parts: string[] = [];
  if (f.status !== 'unresolved') parts.push(`is:${f.status}`);
  if (f.assigned) parts.push(`assigned:${f.assigned}`);
  for (const [k, v] of Object.entries(f.serverTags)) if (v) parts.push(`${k}:${v}`);
  if (f.rawQuery.trim()) parts.push(f.rawQuery.trim());
  if (f.clientText) parts.push(`text~${f.clientText}`);
  for (const [k, v] of Object.entries(f.clientContexts)) if (v) parts.push(`${k}~${v}`);
  if (f.file) parts.push(`file:${f.file.split('/').pop()}`);
  return parts.join(' · ');
}
