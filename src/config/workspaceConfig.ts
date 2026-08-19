import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../util/log';
import {
  ConfigTier,
  EffectiveConfig,
  mergeConfig,
  parseSentryClirc,
  sanitizeTier,
} from './effectiveConfig';

export const CONFIG_DIR = '.sentry_viewer';

async function readJsonIfExists(filePath: string): Promise<ConfigTier | undefined> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return sanitizeTier(JSON.parse(text));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`Failed to read ${filePath}: ${e}`);
    }
    return undefined;
  }
}

function settingsTier(): ConfigTier {
  const cfg = vscode.workspace.getConfiguration('sentry');
  const tier: ConfigTier = {};
  const baseUrl = cfg.get<string>('baseUrl');
  // Only treat explicitly-set values as part of the settings tier so the
  // package.json default doesn't shadow the sentry-cli tier.
  if (baseUrl && baseUrl !== 'https://sentry.io') tier.baseUrl = baseUrl;
  const org = cfg.get<string>('organization');
  if (org) tier.organization = org;
  const project = cfg.get<string>('project');
  if (project) tier.project = project;
  const statsPeriod = cfg.get<string>('statsPeriod');
  if (statsPeriod && statsPeriod !== '90d') tier.statsPeriod = statsPeriod;
  const mappings = cfg.get<Record<string, string>>('pathMappings');
  if (mappings && Object.keys(mappings).length > 0) tier.pathMappings = mappings;
  return tier;
}

export interface WorkspaceConfigInfo {
  /** Workspace folder containing the active .sentry_viewer, if any. */
  folder?: vscode.WorkspaceFolder;
  configPath?: string;
  hasLocal: boolean;
  localGitignored: boolean;
  allFolders: vscode.WorkspaceFolder[];
}

export class ConfigService implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private effective: EffectiveConfig;
  private info: WorkspaceConfigInfo = { hasLocal: false, localGitignored: false, allFolders: [] };
  private readonly disposables: vscode.Disposable[] = [];
  private baseUrlWarningShown = false;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.effective = mergeConfig({});
  }

  static async create(context: vscode.ExtensionContext): Promise<ConfigService> {
    const service = new ConfigService(context);
    await service.reload();

    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_DIR}/*.{json,gitignore}`);
    const reload = () => void service.reload();
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);
    service.disposables.push(
      watcher,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sentry')) void service.reload();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(reload),
    );
    return service;
  }

  get(): EffectiveConfig {
    return this.effective;
  }

  workspaceInfo(): WorkspaceConfigInfo {
    return this.info;
  }

  isConfigured(): boolean {
    return Boolean(this.effective.organization && this.effective.project);
  }

  async setActiveFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    await this.context.workspaceState.update('sentry.activeConfigFolder', folder.uri.toString());
    await this.reload();
  }

  async reload(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const withConfig: vscode.WorkspaceFolder[] = [];
    for (const folder of folders) {
      try {
        await fs.access(path.join(folder.uri.fsPath, CONFIG_DIR, 'config.json'));
        withConfig.push(folder);
      } catch {
        /* no config here */
      }
    }

    const savedActive = this.context.workspaceState.get<string>('sentry.activeConfigFolder');
    const active = withConfig.find((f) => f.uri.toString() === savedActive) ?? withConfig[0];
    void vscode.commands.executeCommand('setContext', 'sentry.multipleConfigs', withConfig.length > 1);

    let workspaceShared: ConfigTier | undefined;
    let workspaceLocal: ConfigTier | undefined;
    let hasLocal = false;
    let localGitignored = false;
    let configPath: string | undefined;

    if (active) {
      const dir = path.join(active.uri.fsPath, CONFIG_DIR);
      configPath = path.join(dir, 'config.json');
      workspaceShared = await readJsonIfExists(configPath);
      workspaceLocal = await readJsonIfExists(path.join(dir, 'local.json'));
      hasLocal = workspaceLocal !== undefined;
      if (hasLocal) {
        try {
          const ignore = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
          localGitignored = /(^|\n)\s*local\.json\s*($|\n)/.test(ignore);
        } catch {
          localGitignored = false;
        }
      }
    }

    let sentryCli: ConfigTier | undefined;
    try {
      const rc = await fs.readFile(path.join(os.homedir(), '.sentryclirc'), 'utf8');
      sentryCli = parseSentryClirc(rc);
    } catch {
      /* no sentry-cli config */
    }

    const settings = settingsTier();

    // Trust gate: a repo-committed config.json may not silently redirect API
    // traffic (and the bearer token) to a different server than the one the
    // user's own tiers point at.
    if (workspaceShared?.baseUrl) {
      const userBaseUrl = settings.baseUrl ?? sentryCli?.baseUrl ?? 'https://sentry.io';
      const wsBaseUrl = workspaceShared.baseUrl.replace(/\/$/, '');
      if (wsBaseUrl !== userBaseUrl.replace(/\/$/, '')) {
        const trusted = this.context.workspaceState.get<string[]>('sentry.trustedBaseUrls', []);
        if (!trusted.includes(wsBaseUrl)) {
          const { baseUrl: _ignored, ...rest } = workspaceShared;
          workspaceShared = rest;
          if (!this.baseUrlWarningShown) {
            this.baseUrlWarningShown = true;
            void vscode.window
              .showWarningMessage(
                `The workspace ${CONFIG_DIR}/config.json points Sentry requests at ${wsBaseUrl}. Use it?`,
                'Trust This URL',
                'Ignore',
              )
              .then(async (choice) => {
                if (choice === 'Trust This URL') {
                  await this.context.workspaceState.update('sentry.trustedBaseUrls', [...trusted, wsBaseUrl]);
                  await this.reload();
                }
              });
          }
        }
      }
    }

    this.effective = mergeConfig({ workspaceLocal, workspaceShared, settings, sentryCli });
    this.info = { folder: active, configPath, hasLocal, localGitignored, allFolders: withConfig };
    this._onDidChange.fire();
  }

  /** Scaffold .sentry_viewer/ in the given folder, pre-filled from the current effective config. */
  async scaffold(folder: vscode.WorkspaceFolder, values: { organization: string; project: string; baseUrl?: string }): Promise<string> {
    const dir = path.join(folder.uri.fsPath, CONFIG_DIR);
    await fs.mkdir(dir, { recursive: true });
    const configFile = path.join(dir, 'config.json');
    const config: Record<string, unknown> = {
      organization: values.organization,
      project: values.project,
    };
    if (values.baseUrl && values.baseUrl !== 'https://sentry.io') config.baseUrl = values.baseUrl;
    await fs.writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
    await fs.writeFile(path.join(dir, '.gitignore'), 'local.json\n');
    await this.reload();
    return configFile;
  }

  /** Merge updates into a .sentry_viewer JSON file (config.json or local.json), creating it if needed. */
  async updateWorkspaceFile(fileName: 'config.json' | 'local.json', updates: Record<string, unknown>): Promise<void> {
    const folder = this.info.folder ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('No workspace folder open');
    const dir = path.join(folder.uri.fsPath, CONFIG_DIR);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
      /* new or invalid file — start fresh */
    }
    const merged = { ...existing, ...updates };
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined || merged[key] === '') delete merged[key];
    }
    await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + '\n');
    try {
      await fs.access(path.join(dir, '.gitignore'));
    } catch {
      await fs.writeFile(path.join(dir, '.gitignore'), 'local.json\n');
    }
    await this.reload();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}
