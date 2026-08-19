import { describe, expect, it } from 'vitest';
import { mergeConfig, parseSentryClirc, sanitizeTier } from '../src/config/effectiveConfig';

describe('mergeConfig', () => {
  it('applies per-field precedence with provenance', () => {
    const cfg = mergeConfig({
      workspaceLocal: { token: 'ws-token' },
      workspaceShared: { organization: 'allucent', project: 'allucent-main-app' },
      settings: { organization: 'ignored-org', statsPeriod: '30d' },
      sentryCli: { token: 'cli-token', organization: 'cli-org' },
    });
    expect(cfg.organization).toBe('allucent');
    expect(cfg.provenance.organization).toBe('workspace');
    expect(cfg.statsPeriod).toBe('30d');
    expect(cfg.provenance.statsPeriod).toBe('settings');
    expect(cfg.baseUrl).toBe('https://sentry.io');
    expect(cfg.provenance.baseUrl).toBe('default');
    expect(cfg.tokenOverride).toBe('ws-token');
    expect(cfg.cliToken).toBe('cli-token');
  });

  it('skips empty strings and empty objects when picking', () => {
    const cfg = mergeConfig({
      workspaceShared: { organization: '', pathMappings: {} },
      settings: { organization: 'org', pathMappings: { 'src/': 'app/src/' } },
    });
    expect(cfg.organization).toBe('org');
    expect(cfg.pathMappings).toEqual({ 'src/': 'app/src/' });
  });

  it('strips trailing slash from baseUrl', () => {
    expect(mergeConfig({ settings: { baseUrl: 'https://sentry.example.com/' } }).baseUrl).toBe('https://sentry.example.com');
  });
});

describe('parseSentryClirc', () => {
  it('reads auth token and defaults sections', () => {
    const tier = parseSentryClirc(`# comment
[auth]
token = sntrys_abc123

[defaults]
org=myorg
project = myproject
url=https://sentry.example.com
`);
    expect(tier.token).toBe('sntrys_abc123');
    expect(tier.organization).toBe('myorg');
    expect(tier.project).toBe('myproject');
    expect(tier.baseUrl).toBe('https://sentry.example.com');
  });

  it('ignores keys outside known sections', () => {
    expect(parseSentryClirc('token=loose\n[other]\ntoken=x\n')).toEqual({});
  });
});

describe('sanitizeTier', () => {
  it('keeps only known, correctly-typed fields', () => {
    expect(
      sanitizeTier({
        organization: 'o',
        project: 42,
        pathMappings: { 'a/': 'b/', bad: 7 },
        extra: true,
      }),
    ).toEqual({ organization: 'o', pathMappings: { 'a/': 'b/' } });
  });

  it('returns {} for non-objects', () => {
    expect(sanitizeTier(null)).toEqual({});
    expect(sanitizeTier('x')).toEqual({});
  });
});
