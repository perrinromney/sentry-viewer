import * as vscode from 'vscode';
import { AuthService } from '../auth';
import { ConfigService } from '../config/workspaceConfig';
import { SentryClient } from '../sentry/client';
import { SettingsFromWebview, SettingsToWebview, SettingsViewModel } from '../shared/messages';
import { log } from '../util/log';
import { makeNonce } from './detailView';

export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private options: { organizations?: string[]; projects?: string[] } = {};

  static show(
    extensionUri: vscode.Uri,
    config: ConfigService,
    auth: AuthService,
    client: SentryClient,
  ): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('sentry.settings', 'Sentry Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    });
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, config, auth, client);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly client: SentryClient,
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
      ...this.options,
    };
  }

  private async postState(): Promise<void> {
    this.post({ type: 'state', vm: await this.buildViewModel() });
  }

  private async onMessage(message: SettingsFromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        break;

      case 'loadOptions':
        try {
          const orgs = await this.client.listOrganizations();
          this.options.organizations = orgs.map((o) => o.slug);
          const projects = await this.client.listProjects();
          this.options.projects = projects.map((p) => p.slug);
        } catch (e) {
          log(`Settings: failed to load orgs/projects: ${e}`);
        }
        await this.postState();
        break;

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

      case 'testConnection':
        try {
          const projects = await this.client.listProjects();
          const cfg = this.config.get();
          const found = projects.find((p) => p.slug === cfg.project);
          this.post({
            type: 'testResult',
            ok: true,
            message: found
              ? `Connected: ${cfg.organization} / ${found.slug} (project id ${found.id})`
              : `Connected to org "${cfg.organization}" (${projects.length} projects), but project "${cfg.project}" was not found`,
          });
        } catch (e) {
          this.post({ type: 'testResult', ok: false, message: `Connection failed: ${e instanceof Error ? e.message : e}` });
        }
        break;

      case 'createWorkspaceConfig':
        await vscode.commands.executeCommand('sentry.initWorkspaceConfig');
        await this.postState();
        break;

      case 'openConfigFile': {
        const path = this.config.workspaceInfo().configPath;
        if (path) await vscode.window.showTextDocument(vscode.Uri.file(path));
        break;
      }
    }
  }
}
