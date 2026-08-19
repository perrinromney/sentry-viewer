import { describe, expect, it } from 'vitest';
import {
  buildClientPredicate,
  buildServerQuery,
  contextValue,
  DEFAULT_FILTER,
  describeFilter,
  isDefaultFilter,
} from '../src/sentry/query';
import type { Issue, SentryEvent } from '../src/sentry/types';

const issue = (over: Partial<Issue> = {}): Issue => ({
  id: '1',
  shortId: 'APP-1',
  title: 'TypeError: Cannot read properties of null',
  culprit: 'rolling-session',
  permalink: 'https://sentry.io/x',
  level: 'error',
  status: 'unresolved',
  count: '10',
  userCount: 5,
  firstSeen: '2026-08-01T00:00:00Z',
  lastSeen: '2026-08-19T00:00:00Z',
  metadata: { type: 'TypeError', value: 'Cannot read properties of null' },
  project: { id: 'p', slug: 'app' },
  ...over,
});

const event: SentryEvent = {
  id: 'e',
  eventID: 'e',
  contexts: {
    vue: { componentName: 'ScheduleVarianceModal', lifecycleHook: 'watch' },
    selection: { company: 'turner', project: 'THM1A', session: '22336260' },
  },
  context: { company: 'turner' },
};

describe('buildServerQuery', () => {
  it('defaults to is:unresolved', () => {
    expect(buildServerQuery(DEFAULT_FILTER)).toBe('is:unresolved');
  });

  it('omits is: for status all and includes tags, assigned, raw query', () => {
    const q = buildServerQuery({
      ...DEFAULT_FILTER,
      status: 'all',
      assigned: 'me',
      serverTags: { company: 'turner', project: 'SFO T3W' },
      rawQuery: 'error.type:TypeError',
    });
    expect(q).toBe('assigned:me company:turner project:"SFO T3W" error.type:TypeError');
  });

  it('quotes values with spaces or colons and escapes quotes', () => {
    expect(buildServerQuery({ ...DEFAULT_FILTER, serverTags: { url: 'https://x/y' } })).toBe(
      'is:unresolved url:"https://x/y"',
    );
    expect(buildServerQuery({ ...DEFAULT_FILTER, serverTags: { t: 'say "hi"' } })).toBe(
      'is:unresolved t:"say \\"hi\\""',
    );
  });
});

describe('client predicate', () => {
  it('text filter matches title/culprit/shortId case-insensitively', () => {
    const p = buildClientPredicate({ ...DEFAULT_FILTER, clientText: 'typeerror' });
    expect(p(issue(), undefined)).toBe(true);
    expect(p(issue({ title: 'Other', metadata: {}, culprit: '' }), undefined)).toBe(false);
  });

  it('context filters pass optimistically without an event, then match on substring', () => {
    const p = buildClientPredicate({ ...DEFAULT_FILTER, clientContexts: { 'vue.componentName': 'schedule' } });
    expect(p(issue(), undefined)).toBe(true); // optimistic
    expect(p(issue(), event)).toBe(true);
    const miss = buildClientPredicate({ ...DEFAULT_FILTER, clientContexts: { 'vue.componentName': 'Other' } });
    expect(miss(issue(), event)).toBe(false);
  });

  it('reads dotted paths and the extra-context fallback', () => {
    expect(contextValue(event, 'selection.session')).toBe('22336260');
    expect(contextValue(event, 'company')).toBe('turner');
    expect(contextValue(event, 'nope.nothing')).toBeUndefined();
  });
});

describe('filter state helpers', () => {
  it('detects the default filter', () => {
    expect(isDefaultFilter(DEFAULT_FILTER)).toBe(true);
    expect(isDefaultFilter({ ...DEFAULT_FILTER, clientText: 'x' })).toBe(false);
    expect(isDefaultFilter({ ...DEFAULT_FILTER, file: '/a.ts' })).toBe(false);
  });

  it('describes active filters compactly', () => {
    expect(describeFilter(DEFAULT_FILTER)).toBe('');
    expect(
      describeFilter({
        ...DEFAULT_FILTER,
        status: 'ignored',
        serverTags: { company: 'turner' },
        clientContexts: { 'vue.componentName': 'Sched' },
      }),
    ).toBe('is:ignored · company:turner · vue.componentName~Sched');
  });
});
