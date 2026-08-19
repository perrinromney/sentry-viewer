import * as vscode from 'vscode';
import { resolveEventLocations } from '../code/frameResolver';
import { WorkspaceIndex } from '../code/workspaceIndex';
import { ConfigService } from '../config/workspaceConfig';
import { IssueStore } from '../store/issueStore';
import { debounce } from '../util/time';

export interface InlineLocation {
  issueId: string;
  shortId: string;
  line: number;
  title: string;
  level: string;
  status: string;
  count: string;
  lastSeen: string;
  permalink: string;
}

/**
 * Shared issue→file:line index that all inline providers (CodeLens,
 * decorations, hovers, status bar) read from. Rebuilt (debounced) whenever
 * cached events, the workspace file index, or config change.
 */
export class LocationIndex implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private byFile = new Map<string, InlineLocation[]>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: IssueStore,
    private readonly index: WorkspaceIndex,
    private readonly config: ConfigService,
  ) {
    const rebuild = debounce(() => this.rebuild(), 500);
    this.disposables.push(
      store.onDidChange(rebuild),
      index.onDidChange(rebuild),
      config.onDidChange(rebuild),
    );
    this.rebuild();
  }

  lookup(fsPath: string): InlineLocation[] {
    return this.byFile.get(fsPath) ?? [];
  }

  issueIdsForFile(fsPath: string): Set<string> {
    return new Set(this.lookup(fsPath).map((l) => l.issueId));
  }

  files(): string[] {
    return [...this.byFile.keys()];
  }

  private rebuild(): void {
    const next = new Map<string, InlineLocation[]>();
    const files = this.index.get();
    if (files.length > 0) {
      const mappings = this.config.get().pathMappings;
      for (const issue of this.store.issuesForLocationIndex()) {
        if (issue.status !== 'unresolved') continue;
        const event = this.store.events.get(issue.id);
        if (!event) continue;
        for (const location of resolveEventLocations(event, files, mappings)) {
          const list = next.get(location.fsPath) ?? [];
          list.push({
            issueId: issue.id,
            shortId: issue.shortId,
            line: location.line,
            title: issue.title,
            level: issue.level,
            status: issue.status,
            count: issue.count,
            lastSeen: issue.lastSeen,
            permalink: issue.permalink,
          });
          next.set(location.fsPath, list);
        }
      }
    }
    this.byFile = next;
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}
