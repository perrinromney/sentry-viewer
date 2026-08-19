/**
 * Pure configuration merge. Precedence per field (first defined wins):
 *   .sentry_viewer/local.json  →  .sentry_viewer/config.json  →  VS Code settings  →  sentry-cli (~/.sentryclirc)  →  built-in default
 * Provenance records where each effective value came from, for display in the settings window.
 */

export type ConfigTierName = 'workspace-local' | 'workspace' | 'settings' | 'sentry-cli' | 'default';

export interface ConfigTier {
  baseUrl?: string;
  organization?: string;
  project?: string;
  statsPeriod?: string;
  pathMappings?: Record<string, string>;
  defaultQuery?: string;
  /** Only meaningful in the workspace-local and sentry-cli tiers. */
  token?: string;
}

export interface EffectiveConfig {
  baseUrl: string;
  organization: string;
  project: string;
  statsPeriod: string;
  pathMappings: Record<string, string>;
  defaultQuery: string;
  /** Token override from .sentry_viewer/local.json, if any (SecretStorage is handled separately). */
  tokenOverride?: string;
  /** Token parsed from ~/.sentryclirc, used for the one-time import offer. */
  cliToken?: string;
  provenance: Record<'baseUrl' | 'organization' | 'project' | 'statsPeriod' | 'pathMappings' | 'defaultQuery', ConfigTierName>;
}

const DEFAULTS: Required<Omit<ConfigTier, 'token'>> = {
  baseUrl: 'https://sentry.io',
  organization: '',
  project: '',
  statsPeriod: '90d',
  pathMappings: {},
  defaultQuery: '',
};

export interface ConfigInputs {
  workspaceLocal?: ConfigTier;
  workspaceShared?: ConfigTier;
  settings?: ConfigTier;
  sentryCli?: ConfigTier;
}

export function mergeConfig(inputs: ConfigInputs): EffectiveConfig {
  const tiers: [ConfigTierName, ConfigTier | undefined][] = [
    ['workspace-local', inputs.workspaceLocal],
    ['workspace', inputs.workspaceShared],
    ['settings', inputs.settings],
    ['sentry-cli', inputs.sentryCli],
  ];

  function pick<K extends keyof typeof DEFAULTS>(key: K): { value: (typeof DEFAULTS)[K]; source: ConfigTierName } {
    for (const [name, tier] of tiers) {
      const v = tier?.[key];
      if (v !== undefined && v !== '' && !(typeof v === 'object' && Object.keys(v).length === 0)) {
        return { value: v as (typeof DEFAULTS)[K], source: name };
      }
    }
    return { value: DEFAULTS[key], source: 'default' };
  }

  const baseUrl = pick('baseUrl');
  const organization = pick('organization');
  const project = pick('project');
  const statsPeriod = pick('statsPeriod');
  const pathMappings = pick('pathMappings');
  const defaultQuery = pick('defaultQuery');

  return {
    baseUrl: baseUrl.value.replace(/\/$/, ''),
    organization: organization.value,
    project: project.value,
    statsPeriod: statsPeriod.value,
    pathMappings: pathMappings.value,
    defaultQuery: defaultQuery.value,
    tokenOverride: inputs.workspaceLocal?.token,
    cliToken: inputs.sentryCli?.token,
    provenance: {
      baseUrl: baseUrl.source,
      organization: organization.source,
      project: project.source,
      statsPeriod: statsPeriod.source,
      pathMappings: pathMappings.source,
      defaultQuery: defaultQuery.source,
    },
  };
}

/** Minimal INI parse of ~/.sentryclirc: [auth] token, [defaults] org/project/url. */
export function parseSentryClirc(content: string): ConfigTier {
  const tier: ConfigTier = {};
  let section = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    const kv = line.match(/^([\w.]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (section === 'auth' && key === 'token') tier.token = value;
    if (section === 'defaults') {
      if (key === 'org') tier.organization = value;
      if (key === 'project') tier.project = value;
      if (key === 'url') tier.baseUrl = value;
    }
  }
  return tier;
}

/** Validate the parsed shape of a .sentry_viewer JSON file, dropping unknown/invalid fields. */
export function sanitizeTier(raw: unknown): ConfigTier {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const tier: ConfigTier = {};
  if (typeof o.baseUrl === 'string') tier.baseUrl = o.baseUrl;
  if (typeof o.organization === 'string') tier.organization = o.organization;
  if (typeof o.project === 'string') tier.project = o.project;
  if (typeof o.statsPeriod === 'string') tier.statsPeriod = o.statsPeriod;
  if (typeof o.defaultQuery === 'string') tier.defaultQuery = o.defaultQuery;
  if (typeof o.token === 'string') tier.token = o.token;
  if (o.pathMappings && typeof o.pathMappings === 'object') {
    const mappings: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.pathMappings as Record<string, unknown>)) {
      if (typeof v === 'string') mappings[k] = v;
    }
    tier.pathMappings = mappings;
  }
  return tier;
}
