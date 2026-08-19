import * as vscode from 'vscode';
import { contextValue } from '../sentry/query';
import { IssueStore } from '../store/issueStore';
import { MemberCache } from '../store/memberCache';

const SERVER_TAG_FIELDS = [
  'level',
  'environment',
  'release',
  'transaction',
  'url',
  'user',
  'browser.name',
  'os.name',
  'device.family',
  'handled',
  'mechanism',
  'company',
  'project',
  'sessionId',
];

const CLIENT_CONTEXT_FIELDS = [
  'vue.componentName',
  'vue.lifecycleHook',
  'selection.company',
  'selection.project',
  'selection.session',
  'culture.timezone',
  'culture.locale',
];

function balancedQuotes(text: string): boolean {
  return (text.match(/"/g) ?? []).length % 2 === 0;
}

/** Distinct values for a server tag key across all cached latest events. */
function tagSuggestions(store: IssueStore, key: string): string[] {
  const values = new Set<string>();
  for (const event of store.events.values()) {
    const tag = event.tags?.find((t) => t.key === key);
    if (tag?.value) values.add(tag.value);
  }
  return [...values].sort();
}

/** Distinct values for a dotted context path across all cached latest events. */
function contextSuggestions(store: IssueStore, path: string): string[] {
  const values = new Set<string>();
  for (const event of store.events.values()) {
    const v = contextValue(event, path);
    if (v !== undefined && v !== null && typeof v !== 'object') values.add(String(v));
  }
  return [...values].sort();
}

async function pickValue(title: string, suggestions: string[], current?: string): Promise<string | undefined> {
  const CUSTOM = '$(edit) Enter a custom value…';
  const CLEAR = '$(clear-all) Clear this filter';
  const items: vscode.QuickPickItem[] = suggestions.map((v) => ({
    label: v,
    description: v === current ? 'current' : undefined,
  }));
  items.push({ label: CUSTOM }, ...(current ? [{ label: CLEAR }] : []));
  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: suggestions.length ? 'Pick a value seen in recent events, or enter your own' : 'Enter a value',
  });
  if (!picked) return undefined;
  if (picked.label === CLEAR) return '';
  if (picked.label === CUSTOM) {
    return vscode.window.showInputBox({ title, value: current, ignoreFocusOut: true });
  }
  return picked.label;
}

export function registerFilterCommands(context: vscode.ExtensionContext, store: IssueStore, members: MemberCache): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('sentry.search', async () => {
      const value = await vscode.window.showInputBox({
        title: 'Search Sentry Issues',
        value: store.filter.rawQuery,
        prompt: 'Sentry query syntax: key:value, quoted values, is:<status>, assigned:<actor>, error.type:TypeError, …',
        placeHolder: 'e.g. company:turner error.type:TypeError',
        ignoreFocusOut: true,
        validateInput: (text) => (balancedQuotes(text) ? undefined : 'Unbalanced quotes'),
      });
      if (value === undefined) return;
      await store.setFilter({ rawQuery: value.trim() });
    }),

    vscode.commands.registerCommand('sentry.clearFilters', async () => {
      await store.clearFilters();
    }),

    vscode.commands.registerCommand('sentry.filter', async () => {
      interface FieldItem extends vscode.QuickPickItem {
        field?: string;
        tier?: 'status' | 'assigned' | 'text' | 'tag' | 'context' | 'customTag' | 'customContext';
      }
      const f = store.filter;
      const active = (v?: string) => (v ? `current: ${v}` : undefined);
      const items: FieldItem[] = [
        { label: 'Status', description: `current: ${f.status}`, tier: 'status' },
        { label: 'Assigned', description: active(f.assigned), tier: 'assigned' },
        { label: 'Title text (client-side)', description: active(f.clientText), tier: 'text' },
        { label: 'Server tags', kind: vscode.QuickPickItemKind.Separator },
        ...SERVER_TAG_FIELDS.map((field) => ({
          label: field,
          description: active(f.serverTags[field]),
          tier: 'tag' as const,
          field,
        })),
        { label: '$(add) Custom tag…', tier: 'customTag' },
        { label: 'Event context (client-side, matches latest event)', kind: vscode.QuickPickItemKind.Separator },
        ...CLIENT_CONTEXT_FIELDS.map((field) => ({
          label: field,
          description: active(f.clientContexts[field]),
          tier: 'context' as const,
          field,
        })),
        { label: '$(add) Custom context path…', tier: 'customContext' },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Filter Sentry Issues',
        placeHolder: 'Pick a field to filter by',
        matchOnDescription: true,
      });
      if (!picked?.tier) return;

      switch (picked.tier) {
        case 'status': {
          const status = await vscode.window.showQuickPick(['unresolved', 'ignored', 'resolved', 'all'], {
            title: 'Issue status',
          });
          if (status) await store.setFilter({ status: status as typeof f.status });
          return;
        }
        case 'assigned': {
          const options: (vscode.QuickPickItem & { actor?: string })[] = [
            { label: 'me', actor: 'me' },
            { label: 'unassigned', actor: 'none' },
            { label: '$(clear-all) Any assignee', actor: undefined },
          ];
          try {
            const { members: memberList, teams } = await members.get();
            options.push(
              ...memberList.map((m) => ({ label: m.email, actor: m.email })),
              ...teams.map((t) => ({ label: `#${t.slug}`, actor: `#${t.slug}` })),
            );
          } catch {
            /* suggestions unavailable; the fixed options still work */
          }
          const choice = await vscode.window.showQuickPick(options, { title: 'Assigned to' });
          if (choice) await store.setFilter({ assigned: choice.actor });
          return;
        }
        case 'text': {
          const text = await vscode.window.showInputBox({
            title: 'Filter by title/culprit text (client-side)',
            value: f.clientText,
            ignoreFocusOut: true,
          });
          if (text !== undefined) await store.setFilter({ clientText: text.trim() });
          return;
        }
        case 'tag':
        case 'customTag': {
          const field =
            picked.tier === 'tag'
              ? picked.field!
              : await vscode.window.showInputBox({ title: 'Tag key', placeHolder: 'e.g. sessionId', ignoreFocusOut: true });
          if (!field) return;
          const value = await pickValue(`Filter by tag: ${field}`, tagSuggestions(store, field), f.serverTags[field]);
          if (value === undefined) return;
          const serverTags = { ...f.serverTags };
          if (value === '') delete serverTags[field];
          else serverTags[field] = value;
          await store.setFilter({ serverTags });
          return;
        }
        case 'context':
        case 'customContext': {
          const field =
            picked.tier === 'context'
              ? picked.field!
              : await vscode.window.showInputBox({
                  title: 'Context path',
                  placeHolder: 'e.g. vue.componentName or selection.session',
                  ignoreFocusOut: true,
                });
          if (!field) return;
          const value = await pickValue(
            `Filter by context: ${field} (substring match on latest event)`,
            contextSuggestions(store, field),
            f.clientContexts[field],
          );
          if (value === undefined) return;
          const clientContexts = { ...f.clientContexts };
          if (value === '') delete clientContexts[field];
          else clientContexts[field] = value;
          await store.setFilter({ clientContexts });
          return;
        }
      }
    }),
  );
}
