import * as path from 'path';
import * as vscode from 'vscode';
import { resolveEventLocations, ResolvedLocation } from '../code/frameResolver';
import { WorkspaceIndex } from '../code/workspaceIndex';
import { ConfigService } from '../config/workspaceConfig';
import { Issue } from '../sentry/types';
import { IssueStore } from '../store/issueStore';
import { compactCount, relativeTime } from '../util/time';

export type TreeNode =
  | { kind: 'issue'; issue: Issue }
  | { kind: 'archivedRoot' }
  | { kind: 'loadMore'; archived: boolean }
  | { kind: 'location'; issue: Issue; location: ResolvedLocation }
  | { kind: 'meta'; issue: Issue; label: string; icon?: string };

function levelIcon(level: string): vscode.ThemeIcon {
  switch (level) {
    case 'fatal':
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'warning':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    default:
      return new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.blue'));
  }
}

export class IssueTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private treeView: vscode.TreeView<TreeNode> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: IssueStore,
    private readonly index: WorkspaceIndex,
    private readonly config: ConfigService,
  ) {
    this.disposables.push(
      store.onDidChange(() => {
        this._onDidChangeTreeData.fire(undefined);
        this.updateChrome();
      }),
      index.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
    );
  }

  attach(treeView: vscode.TreeView<TreeNode>): void {
    this.treeView = treeView;
    this.updateChrome();
  }

  private updateChrome(): void {
    if (!this.treeView) return;
    const count = this.store.openCount;
    this.treeView.badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count}${this.store.openCountIsPartial ? '+' : ''} unresolved Sentry issue${count === 1 ? '' : 's'}`,
          }
        : undefined;
    this.treeView.description = this.store.filterDescription();
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const nodes: TreeNode[] = this.store.visibleIssues().map((issue) => ({ kind: 'issue' as const, issue }));
      if (this.store.nextCursor) nodes.push({ kind: 'loadMore', archived: false });
      if (this.store.filter.status === 'unresolved') nodes.push({ kind: 'archivedRoot' });
      return nodes;
    }
    if (element.kind === 'archivedRoot') {
      if (!this.store.archivedLoaded) {
        void this.store.loadArchived();
        return [];
      }
      const nodes: TreeNode[] = this.store.archived.map((issue) => ({ kind: 'issue' as const, issue }));
      if (this.store.archivedCursor) nodes.push({ kind: 'loadMore', archived: true });
      return nodes;
    }
    if (element.kind === 'issue') {
      return this.issueChildren(element.issue);
    }
    return [];
  }

  private issueChildren(issue: Issue): TreeNode[] {
    const nodes: TreeNode[] = [];
    const event = this.store.events.get(issue.id);
    if (event) {
      const locations = resolveEventLocations(event, this.index.get(), this.config.get().pathMappings);
      for (const location of locations) {
        nodes.push({ kind: 'location', issue, location });
      }
      if (locations.length === 0) {
        nodes.push({ kind: 'meta', issue, label: 'No matching file in workspace', icon: 'link-external' });
      }
    } else {
      void this.store.getEvent(issue.id); // triggers a refresh once cached
      nodes.push({ kind: 'meta', issue, label: 'Loading event…', icon: 'loading~spin' });
    }
    const assignee = issue.assignedTo?.name ?? issue.assignedTo?.email ?? 'unassigned';
    const tagBits: string[] = [];
    if (event) {
      for (const key of ['company', 'project', 'environment']) {
        const tag = event.tags?.find((t) => t.key === key);
        if (tag?.value) tagBits.push(tag.value);
      }
    }
    nodes.push({
      kind: 'meta',
      issue,
      label: `${assignee}${tagBits.length ? '  ·  ' + tagBits.join(' / ') : ''}`,
      icon: 'account',
    });
    return nodes;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'issue': {
        const issue = node.issue;
        const label = issue.metadata.type ?? issue.title;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `issue-${issue.id}`;
        item.description = `${issue.culprit || issue.metadata.value || ''} · ${compactCount(issue.count)} ev · ${relativeTime(issue.lastSeen)}`;
        item.iconPath = levelIcon(issue.level);
        item.contextValue = `issue:${issue.status}`;
        item.tooltip = new vscode.MarkdownString(
          `**${issue.title}**\n\n` +
            `${issue.shortId} · ${issue.level} · ${issue.status}\n\n` +
            `${compactCount(issue.count)} events · ${compactCount(issue.userCount)} users\n\n` +
            `first seen ${relativeTime(issue.firstSeen)} · last seen ${relativeTime(issue.lastSeen)}`,
        );
        item.command = { command: 'sentry.openIssue', title: 'Open Issue', arguments: [issue.id] };
        return item;
      }
      case 'archivedRoot': {
        const item = new vscode.TreeItem('Archived', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = 'archived-root';
        item.iconPath = new vscode.ThemeIcon('archive');
        item.description = this.store.archivedLoaded
          ? `${this.store.archived.length}${this.store.archivedCursor ? '+' : ''}`
          : '';
        item.contextValue = 'archivedRoot';
        return item;
      }
      case 'loadMore': {
        const item = new vscode.TreeItem('Load more…', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        item.command = { command: 'sentry.loadMore', title: 'Load More', arguments: [node.archived] };
        return item;
      }
      case 'location': {
        const { location } = node;
        const fileName = path.basename(location.fsPath);
        const item = new vscode.TreeItem(`${fileName}:${location.line + 1}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('file-code');
        item.description = vscode.workspace.asRelativePath(location.fsPath);
        item.tooltip = location.frame.function ?? undefined;
        item.command = {
          command: 'sentry.openCodeLocation',
          title: 'Go to Code Location',
          arguments: [node.issue.id, location],
        };
        return item;
      }
      case 'meta': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (node.kind === 'issue' && node.issue.status === 'ignored' && this.store.archived.includes(node.issue)) {
      return { kind: 'archivedRoot' };
    }
    return undefined;
  }

  findIssueNode(issueId: string): TreeNode | undefined {
    const issue = this.store.getIssue(issueId);
    return issue ? { kind: 'issue', issue } : undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
