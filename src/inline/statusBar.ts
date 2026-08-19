import * as vscode from 'vscode';
import { IssueStore } from '../store/issueStore';
import { LocationIndex } from './locationIndex';

/** Status bar item showing how many open Sentry issues touch the active file; click toggles the file filter. */
export class SentryStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly index: LocationIndex,
    private readonly store: IssueStore,
  ) {
    this.item = vscode.window.createStatusBarItem('sentry.fileIssues', vscode.StatusBarAlignment.Left, 90);
    this.item.name = 'Sentry Issues';
    this.item.command = 'sentry.toggleFileFilter';
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      index.onDidChange(() => this.update()),
      store.onDidChange(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sentry.inline.statusBar')) this.update();
      }),
    );
    this.update();
  }

  private update(): void {
    const enabled = vscode.workspace.getConfiguration('sentry').get<boolean>('inline.statusBar', true);
    const editor = vscode.window.activeTextEditor;
    if (!enabled || !editor || editor.document.uri.scheme !== 'file') {
      this.item.hide();
      return;
    }
    const issueIds = this.index.issueIdsForFile(editor.document.uri.fsPath);
    if (issueIds.size === 0) {
      this.item.hide();
      return;
    }
    const filtered = this.store.filter.file === editor.document.uri.fsPath;
    this.item.text = `$(bug) ${issueIds.size}`;
    this.item.tooltip = `${issueIds.size} open Sentry issue${issueIds.size === 1 ? '' : 's'} in this file — click to ${filtered ? 'clear the file filter' : 'filter the Sentry view to this file'}`;
    this.item.backgroundColor = filtered ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
