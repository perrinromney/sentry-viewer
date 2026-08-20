import * as path from 'path';
import * as vscode from 'vscode';
import { AuthService } from '../auth';
import { ConfigService } from '../config/workspaceConfig';
import { FiltersFromWebview, FiltersToWebview, FilterViewModel } from '../shared/messages';
import { IssueStore } from '../store/issueStore';
import { MemberCache } from '../store/memberCache';
import { allSuggestions, CLIENT_CONTEXT_FIELDS, SERVER_TAG_FIELDS } from '../store/suggestions';
import { log } from '../util/log';
import { makeNonce } from './detailView';

/** Self-contained filter UI rendered as a webview section above the issues tree. */
export class FilterViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'sentry.filters';

  private view: vscode.WebviewView | undefined;
  private assignees: { label: string; value: string }[] = [];
  private assigneesRequested = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: IssueStore,
    private readonly members: MemberCache,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {
    this.disposables.push(
      store.onDidChange(() => void this.postState()),
      config.onDidChange(() => void this.postState()),
      auth.onDidChange(() => void this.postState()),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    const nonce = makeNonce();
    const scriptUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'filters.js'));
    const styleUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'));
    webviewView.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webviewView.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webviewView.webview.cspSource};">
<link rel="stylesheet" href="${styleUri}">
</head>
<body class="filters-body">
<div id="root" class="filters"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    webviewView.webview.onDidReceiveMessage((message: FiltersFromWebview) => void this.onMessage(message));
    void this.loadAssignees();
  }

  private async loadAssignees(): Promise<void> {
    if (this.assigneesRequested || !(await this.auth.isSignedIn()) || !this.config.isConfigured()) return;
    this.assigneesRequested = true;
    try {
      const { members, teams } = await this.members.get();
      this.assignees = [
        ...members.map((m) => ({ label: m.name || m.user?.name || m.email, value: m.email })),
        ...teams.map((t) => ({ label: `#${t.slug}`, value: `#${t.slug}` })),
      ];
      await this.postState();
    } catch (e) {
      this.assigneesRequested = false; // retry on next resolve/state change
      log(`Filter view: could not load assignees: ${e}`);
    }
  }

  private async buildViewModel(): Promise<FilterViewModel> {
    const signedIn = await this.auth.isSignedIn();
    const configured = this.config.isConfigured();
    const f = this.store.filter;
    return {
      enabled: signedIn && configured,
      disabledReason: !signedIn ? 'Sign in to Sentry to filter issues.' : !configured ? 'Set an organization and project first.' : undefined,
      status: f.status,
      rawQuery: f.rawQuery,
      assigned: f.assigned ?? '',
      clientText: f.clientText,
      serverTags: f.serverTags,
      clientContexts: f.clientContexts,
      fileName: f.file ? path.basename(f.file) : undefined,
      fields: [
        ...SERVER_TAG_FIELDS.map((name) => ({ name, tier: 'tag' as const })),
        ...CLIENT_CONTEXT_FIELDS.map((name) => ({ name, tier: 'context' as const })),
      ],
      suggestions: allSuggestions([...this.store.events.values()]),
      assignees: this.assignees,
      visibleCount: this.store.visibleIssues().length,
      totalCount: this.store.issues.length,
    };
  }

  private async postState(): Promise<void> {
    if (!this.view) return;
    const message: FiltersToWebview = { type: 'state', vm: await this.buildViewModel() };
    void this.view.webview.postMessage(message);
    void this.loadAssignees();
  }

  private async onMessage(message: FiltersFromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.postState();
        break;
      case 'set': {
        const patch: Parameters<IssueStore['setFilter']>[0] = {};
        if (message.patch.status !== undefined) patch.status = message.patch.status;
        if (message.patch.rawQuery !== undefined) patch.rawQuery = message.patch.rawQuery.trim();
        if (message.patch.clientText !== undefined) patch.clientText = message.patch.clientText.trim();
        if (message.patch.assigned !== undefined) patch.assigned = message.patch.assigned || undefined;
        await this.store.setFilter(patch);
        break;
      }
      case 'addFilter': {
        const value = message.value.trim();
        if (!value || !message.field.trim()) return;
        if (message.tier === 'tag') {
          await this.store.setFilter({ serverTags: { ...this.store.filter.serverTags, [message.field.trim()]: value } });
        } else {
          await this.store.setFilter({ clientContexts: { ...this.store.filter.clientContexts, [message.field.trim()]: value } });
        }
        break;
      }
      case 'removeFilter': {
        if (message.kind === 'file') {
          await this.store.setFilter({ file: undefined });
        } else if (message.kind === 'tag' && message.key) {
          const serverTags = { ...this.store.filter.serverTags };
          delete serverTags[message.key];
          await this.store.setFilter({ serverTags });
        } else if (message.kind === 'context' && message.key) {
          const clientContexts = { ...this.store.filter.clientContexts };
          delete clientContexts[message.key];
          await this.store.setFilter({ clientContexts });
        }
        break;
      }
      case 'clearAll':
        await this.store.clearFilters();
        break;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
