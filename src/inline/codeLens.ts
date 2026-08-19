import * as vscode from 'vscode';
import { compactCount, relativeTime } from '../util/time';
import { LocationIndex } from './locationIndex';

export class SentryCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly index: LocationIndex) {
    this.disposables.push(
      index.onDidChange(() => this._onDidChangeCodeLenses.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sentry.inline.codeLens')) this._onDidChangeCodeLenses.fire();
      }),
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('sentry').get<boolean>('inline.codeLens', true)) return [];
    const locations = this.index.lookup(document.uri.fsPath);
    if (locations.length === 0) return [];
    const perLine = new Map<number, number>();
    const lenses: vscode.CodeLens[] = [];
    for (const location of locations) {
      const line = Math.min(location.line, document.lineCount - 1);
      const already = perLine.get(line) ?? 0;
      if (already >= 3) continue;
      perLine.set(line, already + 1);
      const range = document.lineAt(line).range;
      lenses.push(
        new vscode.CodeLens(range, {
          title: `Sentry: ${location.title.length > 60 ? location.title.slice(0, 57) + '…' : location.title} · ${compactCount(location.count)} events · ${relativeTime(location.lastSeen)}`,
          tooltip: `${location.shortId} — click to open in the Sentry panel`,
          command: 'sentry.openIssueFromEditor',
          arguments: [location.issueId],
        }),
      );
    }
    return lenses;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChangeCodeLenses.dispose();
  }
}
