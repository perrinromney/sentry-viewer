import { contextValue } from '../sentry/query';
import type { SentryEvent } from '../sentry/types';

/** Server-side filterable fields (Sentry tags / built-in tokens). */
export const SERVER_TAG_FIELDS = [
  'level',
  'environment',
  'release',
  'transaction',
  'url',
  'user',
  'browser.name',
  'os.name',
  'device.family',
  'handled',
  'mechanism',
  'company',
  'project',
  'sessionId',
];

/** Client-side filterable dotted context paths (matched against latest events). */
export const CLIENT_CONTEXT_FIELDS = [
  'vue.componentName',
  'vue.lifecycleHook',
  'selection.company',
  'selection.project',
  'selection.session',
  'culture.timezone',
  'culture.locale',
];

/** Distinct values for a server tag key across cached latest events. */
export function tagSuggestions(events: Iterable<SentryEvent>, key: string): string[] {
  const values = new Set<string>();
  for (const event of events) {
    const tag = event.tags?.find((t) => t.key === key);
    if (tag?.value) values.add(tag.value);
  }
  return [...values].sort();
}

/** Distinct values for a dotted context path across cached latest events. */
export function contextSuggestions(events: Iterable<SentryEvent>, path: string): string[] {
  const values = new Set<string>();
  for (const event of events) {
    const v = contextValue(event, path);
    if (v !== undefined && v !== null && typeof v !== 'object') values.add(String(v));
  }
  return [...values].sort();
}

/** Suggestions for every known field, for the sidebar filter UI. */
export function allSuggestions(events: SentryEvent[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const field of SERVER_TAG_FIELDS) result[field] = tagSuggestions(events, field);
  for (const field of CLIENT_CONTEXT_FIELDS) result[field] = contextSuggestions(events, field);
  return result;
}
