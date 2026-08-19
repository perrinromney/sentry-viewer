import * as vscode from 'vscode';
import { compactCount, relativeTime } from '../util/time';
import { LocationIndex } from './locationIndex';

export class SentryHoverProvider implements vscode.HoverProvider {
  constructor(private readonly index: LocationIndex) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!vscode.workspace.getConfiguration('sentry').get<boolean>('inline.hovers', true)) return undefined;
    const locations = this.index.lookup(document.uri.fsPath).filter((l) => l.line === position.line);
    if (locations.length === 0) return undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    for (const location of locations.slice(0, 3)) {
      const arg = encodeURIComponent(JSON.stringify([location.issueId]));
      md.appendMarkdown(
        `$(bug) **${location.title.replace(/([\\`*_{}[\]])/g, '\\$1')}**\n\n` +
          `${location.shortId} · ${location.level} · ${compactCount(location.count)} events · last seen ${relativeTime(location.lastSeen)} · line is approximate\n\n` +
          `[Open](command:sentry.openIssueFromEditor?${arg}) · ` +
          `[Resolve](command:sentry.resolveIssue?${arg}) · ` +
          `[Archive](command:sentry.archiveIssue?${arg}) · ` +
          `[Assign](command:sentry.assignIssue?${arg}) · ` +
          `[Open in Sentry](command:sentry.openInBrowser?${arg})\n\n`,
      );
      if (locations.length > 1) md.appendMarkdown('---\n\n');
    }
    return new vscode.Hover(md);
  }
}
