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
  | { type: 'testConnection' }
  | { type: 'createWorkspaceConfig' }
  | { type: 'openConfigFile' }
  | { type: 'loadOptions' };
