import * as vscode from 'vscode';
import { resolveEventLocations, ResolvedLocation } from '../code/frameResolver';
import { WorkspaceIndex } from '../code/workspaceIndex';
import { ConfigService } from '../config/workspaceConfig';
import { IssueStore } from '../store/issueStore';
import { log } from '../util/log';

async function openLocation(location: ResolvedLocation): Promise<void> {
  const document = await vscode.workspace.openTextDocument(location.fsPath);
  const line = Math.min(location.line, document.lineCount - 1);
  const position = new vscode.Position(line, Math.min(location.column, document.lineAt(line).text.length));
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export function registerNavigation(
  context: vscode.ExtensionContext,
  store: IssueStore,
  index: WorkspaceIndex,
  config: ConfigService,
): void {
  const bestLocation = async (issueId: string): Promise<ResolvedLocation | undefined> => {
    const event = await store.getEvent(issueId);
    if (!event) return undefined;
    await index.ensure();
    const locations = resolveEventLocations(event, index.get(), config.get().pathMappings, 1);
    return locations[0];
  };

  const openInBrowser = (issueId: string | undefined): void => {
    const id = issueId ?? store.selectedIssueId;
    const issue = id ? store.getIssue(id) : undefined;
    if (issue?.permalink) void vscode.env.openExternal(vscode.Uri.parse(issue.permalink));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sentry.openIssue', async (issueId: string) => {
      store.select(issueId);
      if (vscode.workspace.getConfiguration('sentry').get<boolean>('openCodeOnSelect', true)) {
        try {
          const location = await bestLocation(issueId);
          if (location) await openLocation(location);
        } catch (e) {
          log(`openIssue code jump failed: ${e}`);
        }
      }
    }),

    vscode.commands.registerCommand('sentry.openIssueFromEditor', (issueId: string) => {
      store.select(issueId);
    }),

    vscode.commands.registerCommand(
      'sentry.openCodeLocation',
      async (arg?: string | { kind: string; issue?: { id: string } }, location?: ResolvedLocation) => {
        const issueId =
          typeof arg === 'string' ? arg : arg && 'issue' in arg && arg.issue ? arg.issue.id : store.selectedIssueId;
        if (!issueId) return;
        if (location) {
          await openLocation(location);
          return;
        }
        const best = await bestLocation(issueId);
        if (best) {
          await openLocation(best);
        } else {
          const issue = store.getIssue(issueId);
          vscode.window.setStatusBarMessage('Sentry: no matching file in workspace — opened in browser', 5000);
          if (issue?.permalink) void vscode.env.openExternal(vscode.Uri.parse(issue.permalink));
        }
      },
    ),

    vscode.commands.registerCommand(
      'sentry.openInBrowser',
      (arg?: string | { kind: string; issue?: { id: string } }) => {
        const issueId = typeof arg === 'string' ? arg : arg && 'issue' in arg && arg.issue ? arg.issue.id : undefined;
        openInBrowser(issueId);
      },
    ),

    vscode.commands.registerCommand('sentry.loadMore', (archived?: boolean) => {
      if (archived) void store.loadMoreArchived();
      else void store.loadMore();
    }),

    vscode.commands.registerCommand('sentry.toggleFileFilter', async () => {
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (store.filter.file) {
        await store.setFilter({ file: undefined });
        vscode.window.setStatusBarMessage('Sentry: file filter cleared', 3000);
      } else if (active) {
        await store.setFilter({ file: active });
        await vscode.commands.executeCommand('sentry.issues.focus');
      }
    }),
  );
}
