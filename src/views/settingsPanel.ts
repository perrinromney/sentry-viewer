import * as vscode from 'vscode';
import { AuthService } from '../auth';
import { ConfigService } from '../config/workspaceConfig';
import { SentryClient } from '../sentry/client';
import * as fs from 'fs/promises';
import { SettingsFromWebview, SettingsToWebview, SettingsViewModel } from '../shared/messages';
import { clearLog, getLogFile, log, showLog } from '../util/log';
import { makeNonce } from './detailView';

export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private options: { organizations?: string[]; projects?: string[] } = {};

  static show(extensionUri: vscode.Uri, config: ConfigService, auth: AuthService): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('sentry.settings', 'Sentry Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, config, auth);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {
    const nonce = makeNonce();
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'settings.js'));
    const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource};">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="root" class="settings"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    panel.webview.onDidReceiveMessage((m: SettingsFromWebview) => void this.onMessage(m), undefined, this.disposables);
    this.disposables.push(this.config.onDidChange(() => void this.postState()));
    panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
      for (const d of this.disposables) d.dispose();
    });
  }

  private post(message: SettingsToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * Client that targets the org/baseUrl currently typed into the form (not
   * yet saved), so Test Connection and suggestion loading work while the
   * user is still configuring. No onAuthFail: a bad probe here must not
   * trigger the global "session invalid" flow.
   */
  private clientFor(overrides: { organization?: string; baseUrl?: string }): SentryClient {
    const cfg = () => this.config.get();
    return new SentryClient({
      getBaseUrl: () => (overrides.baseUrl !== undefined ? overrides.baseUrl.trim().replace(/\/$/, '') || cfg().baseUrl : cfg().baseUrl),
      getOrg: () => (overrides.organization !== undefined ? overrides.organization.trim() : cfg().organization),
      getToken: () => this.auth.getToken(),
      log,
    });
  }

  private async buildViewModel(): Promise<SettingsViewModel> {
    const effective = this.config.get();
    const info = this.config.workspaceInfo();
    const settings = vscode.workspace.getConfiguration('sentry');
    const tokenStatus = effective.tokenOverride
      ? 'workspace-override'
      : (await this.auth.isSignedIn())
        ? 'secret-storage'
        : 'none';
    return {
      baseUrl: { value: effective.baseUrl, source: effective.provenance.baseUrl },
      organization: { value: effective.organization, source: effective.provenance.organization },
      project: { value: effective.project, source: effective.provenance.project },
      statsPeriod: { value: effective.statsPeriod, source: effective.provenance.statsPeriod },
      pathMappings: { value: effective.pathMappings, source: effective.provenance.pathMappings },
      defaultQuery: { value: effective.defaultQuery, source: effective.provenance.defaultQuery },
      pollIntervalSeconds: settings.get<number>('pollIntervalSeconds', 60),
      openCodeOnSelect: settings.get<boolean>('openCodeOnSelect', true),
      inline: {
        codeLens: settings.get<boolean>('inline.codeLens', true),
        decorations: settings.get<boolean>('inline.decorations', true),
        hovers: settings.get<boolean>('inline.hovers', true),
        statusBar: settings.get<boolean>('inline.statusBar', true),
      },
      tokenStatus,
      cliTokenAvailable: Boolean(effective.cliToken),
      workspace: {
        hasFolder: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
        configPath: info.configPath,
        hasLocal: info.hasLocal,
        localGitignored: info.localGitignored,
      },
      log: await this.logInfo(),
      ...this.options,
    };
  }

  private async logInfo(): Promise<SettingsViewModel['log']> {
    const path = getLogFile();
    if (!path) return { sizeBytes: 0 };
    const stat = await fs.stat(path).catch(() => undefined);
    return { path, sizeBytes: stat?.size ?? 0 };
  }

  private async postState(): Promise<void> {
    this.post({ type: 'state', vm: await this.buildViewModel() });
  }

  private async onMessage(message: SettingsFromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        break;

      case 'loadOptions': {
        const probe = this.clientFor(message);
        try {
          const orgs = await probe.listOrganizations();
          this.options.organizations = orgs.map((o) => o.slug);
          // If no org is chosen yet but the token only sees one, use it for
          // the project list (and the webview will suggest it in the field).
          let orgForProjects = message.organization?.trim() ?? this.config.get().organization;
          if (!orgForProjects && orgs.length === 1) orgForProjects = orgs[0].slug;
          if (orgForProjects) {
            const projects = await this.clientFor({ ...message, organization: orgForProjects }).listProjects();
            this.options.projects = projects.map((p) => p.slug);
          } else {
            this.options.projects = undefined;
          }
        } catch (e) {
          log(`Settings: failed to load orgs/projects: ${e}`);
          this.post({
            type: 'testResult',
            ok: false,
            message: `Could not load suggestions: ${e instanceof Error ? e.message : e}`,
          });
        }
        await this.postState();
        break;
      }

      case 'save': {
        const c = message.changes;
        try {
          if (message.scope === 'workspace') {
            await this.config.updateWorkspaceFile('config.json', {
              baseUrl: c.baseUrl === 'https://sentry.io' ? undefined : c.baseUrl,
              organization: c.organization,
              project: c.project,
              statsPeriod: c.statsPeriod === '90d' ? undefined : c.statsPeriod,
              defaultQuery: c.defaultQuery || undefined,
              pathMappings: c.pathMappings && Object.keys(c.pathMappings).length ? c.pathMappings : undefined,
            });
          } else {
            const settings = vscode.workspace.getConfiguration('sentry');
            const target = vscode.ConfigurationTarget.Global;
            if (c.baseUrl !== undefined) await settings.update('baseUrl', c.baseUrl, target);
            if (c.organization !== undefined) await settings.update('organization', c.organization, target);
            if (c.project !== undefined) await settings.update('project', c.project, target);
            if (c.statsPeriod !== undefined) await settings.update('statsPeriod', c.statsPeriod, target);
            if (c.pathMappings !== undefined) await settings.update('pathMappings', c.pathMappings, target);
          }
          // Behavior settings always live in user settings.
          const settings = vscode.workspace.getConfiguration('sentry');
          const target = vscode.ConfigurationTarget.Global;
          if (c.pollIntervalSeconds !== undefined) await settings.update('pollIntervalSeconds', c.pollIntervalSeconds, target);
          if (c.openCodeOnSelect !== undefined) await settings.update('openCodeOnSelect', c.openCodeOnSelect, target);
          if (c.inline) {
            for (const [key, value] of Object.entries(c.inline)) {
              if (value !== undefined) await settings.update(`inline.${key}`, value, target);
            }
          }
          this.post({ type: 'saved' });
          await this.postState();
        } catch (e) {
          this.post({ type: 'testResult', ok: false, message: `Save failed: ${e instanceof Error ? e.message : e}` });
        }
        break;
      }

      case 'setToken': {
        const token = await vscode.window.showInputBox({
          title: message.scope === 'workspace' ? 'Workspace Token Override (.sentry_viewer/local.json)' : 'Sentry Auth Token',
          password: true,
          ignoreFocusOut: true,
          placeHolder: 'sntrys_… or legacy token (leave empty to clear)',
        });
        if (token === undefined) return;
        if (message.scope === 'workspace') {
          await this.config.updateWorkspaceFile('local.json', { token: token || undefined });
        } else if (token) {
          await this.auth.setToken(token);
        } else {
          await this.auth.signOut();
        }
        await this.postState();
        break;
      }

      case 'importCliToken':
        await this.auth.importCliToken();
        await this.postState();
        break;

      case 'testConnection': {
        // Staged test against the values currently in the form: token → org → project.
        if (!(await this.auth.getToken())) {
          this.post({ type: 'testResult', ok: false, message: 'No token set — set one or import from sentry-cli first.' });
          break;
        }
        const probe = this.clientFor(message);
        const org = message.organization?.trim() ?? this.config.get().organization;
        const project = message.project?.trim() ?? this.config.get().project;
        try {
          const orgs = await probe.listOrganizations();
          if (!org) {
            this.post({
              type: 'testResult',
              ok: true,
              message: `Token is valid. Visible organizations: ${orgs.map((o) => o.slug).join(', ') || '(none)'} — set one above.`,
            });
            break;
          }
          const projects = await probe.listProjects();
          if (!project) {
            this.post({
              type: 'testResult',
              ok: true,
              message: `Connected to org "${org}" (${projects.length} projects: ${projects.slice(0, 5).map((p) => p.slug).join(', ')}${projects.length > 5 ? ', …' : ''}) — set a project above.`,
            });
            break;
          }
          const found = projects.find((p) => p.slug === project);
          this.post({
            type: 'testResult',
            ok: Boolean(found),
            message: found
              ? `Connected: ${org} / ${found.slug} (project id ${found.id})`
              : `Org "${org}" is reachable, but project "${project}" was not found. Projects: ${projects.slice(0, 8).map((p) => p.slug).join(', ')}`,
          });
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          const hint = /404/.test(detail) && org ? ` — is organization "${org}" correct?` : '';
          this.post({ type: 'testResult', ok: false, message: `Connection failed: ${detail}${hint}` });
        }
        break;
      }

      case 'createWorkspaceConfig':
        await vscode.commands.executeCommand('sentry.initWorkspaceConfig');
        await this.postState();
        break;

      case 'openConfigFile': {
        const path = this.config.workspaceInfo().configPath;
        if (path) await vscode.window.showTextDocument(vscode.Uri.file(path));
        break;
      }

      case 'viewLogs':
        await showLog();
        break;

      case 'clearLogs':
        await clearLog();
        this.post({ type: 'testResult', ok: true, message: 'Debug log cleared.' });
        await this.postState();
        break;
    }
  }
}
