import * as vscode from 'vscode';
import { candidateFrames, resolveFrame, ResolvedLocation } from '../code/frameResolver';
import { WorkspaceIndex } from '../code/workspaceIndex';
import { ConfigService } from '../config/workspaceConfig';
import { Breadcrumb, Frame, Issue, SentryEvent } from '../sentry/types';
import { DetailFromWebview, DetailToWebview, IssueDetailViewModel } from '../shared/messages';
import { IssueStore } from '../store/issueStore';
import { log } from '../util/log';

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function frameDisplay(frame: Frame): string {
  const raw = frame.filename ?? frame.absPath ?? '<unknown>';
  return raw.replace(/^(\.\.\/)+/, '').replace(/^https?:\/\/[^/]+/, '');
}

export class DetailViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'sentry.issueDetail';

  private view: vscode.WebviewView | undefined;
  private currentVm: IssueDetailViewModel | undefined;
  private currentLocations = new Map<number, ResolvedLocation>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: IssueStore,
    private readonly index: WorkspaceIndex,
    private readonly config: ConfigService,
  ) {
    this.disposables.push(
      store.onDidChangeSelection((issueId) => {
        if (issueId) void this.showIssue(issueId);
      }),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: DetailFromWebview) => void this.onMessage(message));
  }

  private post(message: DetailToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private async onMessage(message: DetailFromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.currentVm) this.post({ type: 'showIssue', vm: this.currentVm });
        else this.post({ type: 'clear' });
        break;
      case 'openFrame': {
        const location = this.currentLocations.get(message.frameIndex);
        if (location) await vscode.commands.executeCommand('sentry.openCodeLocation', message.issueId, location);
        break;
      }
      case 'openInBrowser':
        await vscode.commands.executeCommand('sentry.openInBrowser', message.issueId);
        break;
      case 'action': {
        const commandByAction = {
          resolve: 'sentry.resolveIssue',
          resolveNextRelease: 'sentry.resolveInNextRelease',
          archive: 'sentry.archiveIssue',
          unresolve: 'sentry.unresolveIssue',
          assign: 'sentry.assignIssue',
        } as const;
        await vscode.commands.executeCommand(commandByAction[message.action], message.issueId);
        break;
      }
    }
  }

  async showIssue(issueId: string): Promise<void> {
    const issue = this.store.getIssue(issueId);
    if (!issue) return;
    this.view?.show?.(true);
    this.post({ type: 'loading', issueId, title: issue.title });
    try {
      const event = await this.store.getEvent(issueId);
      this.currentVm = this.buildViewModel(issue, event);
      this.post({ type: 'showIssue', vm: this.currentVm });
    } catch (e) {
      log(`Detail view failed for ${issue.shortId}: ${e}`);
      this.post({ type: 'error', message: `Could not load event details: ${e}` });
    }
  }

  refreshIfShowing(issueId: string): void {
    if (this.currentVm?.issueId === issueId) void this.showIssue(issueId);
  }

  private buildViewModel(issue: Issue, event: SentryEvent | undefined): IssueDetailViewModel {
    this.currentLocations.clear();
    const frames: IssueDetailViewModel['frames'] = [];
    const contexts: { key: string; value: string }[] = [];
    const breadcrumbs: IssueDetailViewModel['breadcrumbs'] = [];

    if (event) {
      const mappings = this.config.get().pathMappings;
      const workspaceFiles = this.index.get();
      candidateFrames(event).forEach((frame, i) => {
        const resolved = resolveFrame(frame, workspaceFiles, mappings);
        if (resolved) this.currentLocations.set(i, resolved);
        frames.push({
          display: frameDisplay(frame),
          functionName: frame.function ?? '',
          lineNo: frame.lineNo ?? null,
          inApp: Boolean(frame.inApp),
          resolvable: Boolean(resolved),
          frameIndex: i,
        });
      });

      for (const [ctxKey, ctx] of Object.entries(event.contexts ?? {})) {
        if (!ctx || ctxKey === 'trace') continue;
        for (const [k, v] of Object.entries(ctx)) {
          if (k === 'type' || v === null || v === undefined) continue;
          if (typeof v === 'object') continue;
          contexts.push({ key: `${ctxKey}.${k}`, value: String(v) });
        }
      }
      for (const [k, v] of Object.entries(event.context ?? {})) {
        if (v === null || v === undefined || typeof v === 'object') continue;
        contexts.push({ key: `extra.${k}`, value: String(v) });
      }

      for (const entry of event.entries ?? []) {
        if (entry.type !== 'breadcrumbs') continue;
        const values = (entry.data as { values?: Breadcrumb[] }).values ?? [];
        for (const crumb of values.slice(-20)) {
          breadcrumbs.push({
            category: crumb.category ?? crumb.type ?? '',
            message: crumb.message ?? (crumb.data ? JSON.stringify(crumb.data).slice(0, 200) : ''),
            level: crumb.level ?? '',
            timestamp: crumb.timestamp ?? '',
          });
        }
      }
    }

    return {
      issueId: issue.id,
      shortId: issue.shortId,
      title: issue.title,
      culprit: issue.culprit,
      level: issue.level,
      status: issue.status,
      permalink: issue.permalink,
      count: issue.count,
      userCount: issue.userCount,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      assignee: issue.assignedTo ? (issue.assignedTo.name ?? issue.assignedTo.email ?? null) : null,
      tags: (event?.tags ?? []).map((t) => ({ key: t.key, value: t.value })),
      contexts,
      breadcrumbs,
      frames: frames.slice(0, 40),
    };
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="root" class="empty">Select a Sentry issue to see details.</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
