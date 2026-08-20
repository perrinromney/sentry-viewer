/** Typed messages exchanged between the extension host and the two webviews. */

export interface FrameViewModel {
  display: string;
  functionName: string;
  lineNo: number | null;
  inApp: boolean;
  resolvable: boolean;
  /** Index into the resolved-locations list held extension-side. */
  frameIndex: number;
}

export interface IssueDetailViewModel {
  issueId: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  status: string;
  permalink: string;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  assignee: string | null;
  tags: { key: string; value: string }[];
  contexts: { key: string; value: string }[];
  breadcrumbs: { category: string; message: string; level: string; timestamp: string }[];
  frames: FrameViewModel[];
}

export type DetailToWebview =
  | { type: 'showIssue'; vm: IssueDetailViewModel }
  | { type: 'loading'; issueId: string; title: string }
  | { type: 'clear' }
  | { type: 'error'; message: string };

export type DetailFromWebview =
  | { type: 'ready' }
  | { type: 'openFrame'; issueId: string; frameIndex: number }
  | { type: 'openInBrowser'; issueId: string }
  | { type: 'action'; issueId: string; action: 'resolve' | 'resolveNextRelease' | 'archive' | 'unresolve' | 'assign' };

/* ---- Sidebar filter view ---- */

export interface FilterViewModel {
  enabled: boolean;
  /** Hint shown when disabled ("sign in", "configure org/project"). */
  disabledReason?: string;
  status: 'unresolved' | 'ignored' | 'resolved' | 'all';
  rawQuery: string;
  assigned: string;
  clientText: string;
  serverTags: Record<string, string>;
  clientContexts: Record<string, string>;
  /** Basename of the active file filter, if any. */
  fileName?: string;
  fields: { name: string; tier: 'tag' | 'context' }[];
  suggestions: Record<string, string[]>;
  assignees: { label: string; value: string }[];
  visibleCount: number;
  totalCount: number;
}

export type FiltersToWebview = { type: 'state'; vm: FilterViewModel };

export type FiltersFromWebview =
  | { type: 'ready' }
  | { type: 'set'; patch: { status?: FilterViewModel['status']; rawQuery?: string; assigned?: string; clientText?: string } }
  | { type: 'addFilter'; tier: 'tag' | 'context'; field: string; value: string }
  | { type: 'removeFilter'; kind: 'tag' | 'context' | 'file'; key?: string }
  | { type: 'clearAll' };

/* ---- Settings window ---- */

export interface SettingsField<T> {
  value: T;
  source: string;
}

export interface SettingsViewModel {
  baseUrl: SettingsField<string>;
  organization: SettingsField<string>;
  project: SettingsField<string>;
  statsPeriod: SettingsField<string>;
  pathMappings: SettingsField<Record<string, string>>;
  defaultQuery: SettingsField<string>;
  pollIntervalSeconds: number;
  openCodeOnSelect: boolean;
  inline: { codeLens: boolean; decorations: boolean; hovers: boolean; statusBar: boolean };
  tokenStatus: 'workspace-override' | 'secret-storage' | 'none';
  cliTokenAvailable: boolean;
  workspace: {
    hasFolder: boolean;
    configPath?: string;
    hasLocal: boolean;
    localGitignored: boolean;
  };
  log: { path?: string; sizeBytes: number };
  organizations?: string[];
  projects?: string[];
}

export type SettingsScope = 'workspace' | 'user';

export type SettingsToWebview =
  | { type: 'state'; vm: SettingsViewModel }
  | { type: 'testResult'; ok: boolean; message: string }
  | { type: 'saved' };

export type SettingsFromWebview =
  | { type: 'ready' }
  | {
      type: 'save';
      scope: SettingsScope;
      changes: {
        baseUrl?: string;
        organization?: string;
        project?: string;
        statsPeriod?: string;
        defaultQuery?: string;
        pathMappings?: Record<string, string>;
        pollIntervalSeconds?: number;
        openCodeOnSelect?: boolean;
        inline?: { codeLens?: boolean; decorations?: boolean; hovers?: boolean; statusBar?: boolean };
      };
    }
  | { type: 'setToken'; scope: 'secret-storage' | 'workspace' }
  | { type: 'importCliToken' }
  | { type: 'testConnection'; organization?: string; project?: string; baseUrl?: string }
  | { type: 'createWorkspaceConfig' }
  | { type: 'openConfigFile' }
  | { type: 'viewLogs' }
  | { type: 'clearLogs' }
  | { type: 'loadOptions'; organization?: string; baseUrl?: string };
