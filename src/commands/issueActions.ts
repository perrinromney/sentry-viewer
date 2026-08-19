import * as vscode from 'vscode';
import { IssueUpdate } from '../sentry/types';
import { IssueStore } from '../store/issueStore';
import { MemberCache } from '../store/memberCache';
import { DetailViewProvider } from '../views/detailView';
import { TreeNode } from '../views/issueTree';

type CommandArg = string | TreeNode | undefined;

function extractIssueId(arg: CommandArg, store: IssueStore): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && 'kind' in arg && arg.kind === 'issue') return arg.issue.id;
  return store.selectedIssueId;
}

export function registerIssueActions(
  context: vscode.ExtensionContext,
  store: IssueStore,
  members: MemberCache,
  detail: DetailViewProvider,
): void {
  const run = async (arg: CommandArg, update: IssueUpdate, verb: string) => {
    const issueId = extractIssueId(arg, store);
    if (!issueId) {
      void vscode.window.showWarningMessage('No Sentry issue selected.');
      return;
    }
    const issue = store.getIssue(issueId);
    try {
      await store.applyUpdate([issueId], update);
      detail.refreshIfShowing(issueId);
      vscode.window.setStatusBarMessage(`Sentry: ${verb} ${issue?.shortId ?? issueId}`, 4000);
    } catch (e) {
      void vscode.window.showErrorMessage(`Sentry: failed to ${verb.toLowerCase()} ${issue?.shortId ?? issueId}: ${e instanceof Error ? e.message : e}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sentry.resolveIssue', (arg: CommandArg) =>
      run(arg, { status: 'resolved' }, 'Resolved'),
    ),
    vscode.commands.registerCommand('sentry.resolveInNextRelease', (arg: CommandArg) =>
      run(arg, { status: 'resolved', statusDetails: { inNextRelease: true } }, 'Resolved (next release)'),
    ),
    vscode.commands.registerCommand('sentry.unresolveIssue', (arg: CommandArg) =>
      run(arg, { status: 'unresolved' }, 'Unresolved'),
    ),
    vscode.commands.registerCommand('sentry.archiveIssue', (arg: CommandArg) =>
      run(arg, { status: 'ignored', substatus: 'archived_forever' }, 'Archived'),
    ),
    vscode.commands.registerCommand('sentry.unarchiveIssue', (arg: CommandArg) =>
      run(arg, { status: 'unresolved' }, 'Unarchived'),
    ),
    vscode.commands.registerCommand('sentry.assignIssue', async (arg: CommandArg) => {
      const issueId = extractIssueId(arg, store);
      if (!issueId) {
        void vscode.window.showWarningMessage('No Sentry issue selected.');
        return;
      }
      let items: (vscode.QuickPickItem & { actor: string })[];
      try {
        const { members: memberList, teams } = await members.get();
        items = [
          ...memberList.map((m) => ({
            label: `$(account) ${m.name || m.user?.name || m.email}`,
            description: m.email,
            actor: m.user?.id ? `user:${m.user.id}` : m.email,
          })),
          ...teams.map((t) => ({
            label: `$(organization) #${t.slug}`,
            description: t.name && t.name !== t.slug ? t.name : undefined,
            actor: `team:${t.id}`,
          })),
          { label: '$(x) Unassign', actor: '' },
        ];
      } catch (e) {
        void vscode.window.showErrorMessage(`Sentry: could not load members/teams: ${e instanceof Error ? e.message : e}`);
        return;
      }
      const picked = await vscode.window.showQuickPick(items, { title: 'Assign Sentry issue to…' });
      if (picked === undefined) return;
      await run(issueId, { assignedTo: picked.actor }, picked.actor ? `Assigned (${picked.label.replace(/\$\([^)]+\)\s*/, '')})` : 'Unassigned');
    }),
  );
}
