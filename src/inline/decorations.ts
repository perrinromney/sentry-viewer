import * as vscode from 'vscode';
import { LocationIndex } from './locationIndex';

function gutterIcon(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

const STYLES: Record<string, { background: string; icon: string }> = {
  error: { background: 'rgba(246, 84, 84, 0.07)', icon: '#f65454' },
  warning: { background: 'rgba(255, 204, 0, 0.07)', icon: '#ffcc00' },
  info: { background: 'rgba(64, 140, 255, 0.07)', icon: '#408cff' },
};

export class SentryDecorations implements vscode.Disposable {
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly index: LocationIndex) {
    for (const [level, style] of Object.entries(STYLES)) {
      this.types.set(
        level,
        vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: style.background,
          overviewRulerColor: style.icon,
          overviewRulerLane: vscode.OverviewRulerLane.Right,
          gutterIconPath: gutterIcon(style.icon),
          gutterIconSize: 'auto',
        }),
      );
    }
    this.disposables.push(
      index.onDidChange(() => this.applyAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.applyAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sentry.inline.decorations')) this.applyAll();
      }),
    );
    this.applyAll();
  }

  private levelKey(level: string): string {
    if (level === 'fatal' || level === 'error') return 'error';
    if (level === 'warning') return 'warning';
    return 'info';
  }

  private applyAll(): void {
    const enabled = vscode.workspace.getConfiguration('sentry').get<boolean>('inline.decorations', true);
    for (const editor of vscode.window.visibleTextEditors) {
      const locations = enabled ? this.index.lookup(editor.document.uri.fsPath) : [];
      const byLevel = new Map<string, vscode.Range[]>();
      for (const location of locations) {
        const line = Math.min(location.line, editor.document.lineCount - 1);
        const key = this.levelKey(location.level);
        const ranges = byLevel.get(key) ?? [];
        ranges.push(editor.document.lineAt(line).range);
        byLevel.set(key, ranges);
      }
      for (const [level, type] of this.types) {
        editor.setDecorations(type, byLevel.get(level) ?? []);
      }
    }
  }

  dispose(): void {
    for (const type of this.types.values()) type.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
