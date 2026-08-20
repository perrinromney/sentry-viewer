import * as vscode from 'vscode';
import { AuthService } from './auth';
import { WorkspaceIndex } from './code/workspaceIndex';
import { registerFilterCommands } from './commands/filterCommands';
import { registerIssueActions } from './commands/issueActions';
import { registerNavigation } from './commands/navigation';
import { ConfigService } from './config/workspaceConfig';
import { SentryCodeLensProvider } from './inline/codeLens';
import { SentryDecorations } from './inline/decorations';
import { SentryHoverProvider } from './inline/hover';
import { LocationIndex } from './inline/locationIndex';
import { SentryStatusBar } from './inline/statusBar';
import { SentryClient } from './sentry/client';
import { IssueStore } from './store/issueStore';
import { MemberCache } from './store/memberCache';
import { DetailViewProvider } from './views/detailView';
import { FilterViewProvider } from './views/filterView';
import { IssueTreeProvider, TreeNode } from './views/issueTree';
import { SettingsPanel } from './views/settingsPanel';
import { clearLog, initLog, log, setLogDirectory, showLog } from './util/log';

/** Unstable API returned from activate(), used by integration tests. */
export interface SentryViewerApi {
  store: IssueStore;
  config: ConfigService;
}

export async function activate(context: vscode.ExtensionContext): Promise<SentryViewerApi> {
  initLog(context);
  log('Sentry Viewer activating');

  const config = await ConfigService.create(context);
  context.subscriptions.push(config);
  const syncLogDirectory = () => {
    const folder = config.workspaceInfo().folder;
    setLogDirectory(folder ? vscode.Uri.joinPath(folder.uri, '.sentry_viewer').fsPath : undefined);
  };
  syncLogDirectory();
  const auth = new AuthService(context, config);

  let authFailNotified = false;
  const client = new SentryClient({
    getBaseUrl: () => config.get().baseUrl,
    getOrg: () => config.get().organization,
    getToken: () => auth.getToken(),
    log: (m) => log(m),
    onAuthFail: () => {
      void auth.updateContextKey();
      store.pausePolling();
      if (!authFailNotified) {
        authFailNotified = true;
        void vscode.window
          .showWarningMessage('Sentry session is invalid or expired.', 'Sign In')
          .then(async (choice) => {
            if (choice === 'Sign In') await vscode.commands.executeCommand('sentry.signIn');
          });
      }
    },
  });

  const store = new IssueStore(client, config, context.workspaceState);
  context.subscriptions.push(store);
  const memberCache = new MemberCache(client);
  const workspaceIndex = new WorkspaceIndex();
  context.subscriptions.push(workspaceIndex);

  /* Sidebar tree */
  const treeProvider = new IssueTreeProvider(store, workspaceIndex, config);
  context.subscriptions.push(treeProvider);
  const treeView = vscode.window.createTreeView<TreeNode>('sentry.issues', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);
  treeProvider.attach(treeView);
  treeView.onDidChangeSelection((e) => {
    const node = e.selection[0];
    if (node?.kind === 'issue') store.selectedIssueId = node.issue.id;
  });

  /* Sidebar filter view */
  const filterView = new FilterViewProvider(context.extensionUri, store, memberCache, config, auth);
  context.subscriptions.push(
    filterView,
    vscode.window.registerWebviewViewProvider(FilterViewProvider.viewId, filterView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  /* Bottom panel detail view */
  const detail = new DetailViewProvider(context.extensionUri, store, workspaceIndex, config);
  context.subscriptions.push(detail);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DetailViewProvider.viewId, detail, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  /* Inline providers */
  const locationIndex = new LocationIndex(store, workspaceIndex, config);
  context.subscriptions.push(locationIndex);
  store.fileIssueLookup = (fsPath) => locationIndex.issueIdsForFile(fsPath);
  const codeLensProvider = new SentryCodeLensProvider(locationIndex);
  context.subscriptions.push(
    codeLensProvider,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new SentryHoverProvider(locationIndex)),
    new SentryDecorations(locationIndex),
    new SentryStatusBar(locationIndex, store),
  );

  /* Commands */
  registerIssueActions(context, store, memberCache, detail);
  registerFilterCommands(context, store, memberCache);
  registerNavigation(context, store, workspaceIndex, config);

  context.subscriptions.push(
    vscode.commands.registerCommand('sentry.signIn', async () => {
      if (await auth.signIn()) {
        authFailNotified = false;
        store.resumePolling();
        const cfg = config.get();
        if (!cfg.organization) {
          void vscode.window
            .showInformationMessage('Signed in to Sentry. Next, set your organization and project.', 'Open Sentry Settings')
            .then((choice) => {
              if (choice) void vscode.commands.executeCommand('sentry.openSettings');
            });
        } else {
          try {
            const projects = await client.listProjects();
            void vscode.window.showInformationMessage(
              cfg.project
                ? `Connected to Sentry: ${cfg.organization} / ${cfg.project}`
                : `Connected to Sentry org "${cfg.organization}" (${projects.length} projects)`,
            );
          } catch (e) {
            void vscode.window.showWarningMessage(`Signed in, but the connection test failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        await refreshAll();
      }
    }),

    vscode.commands.registerCommand('sentry.signOut', async () => {
      await auth.signOut();
      store.pausePolling();
    }),

    vscode.commands.registerCommand('sentry.refresh', async () => {
      await store.refresh();
    }),

    vscode.commands.registerCommand('sentry.openSettings', () => {
      SettingsPanel.show(context.extensionUri, config, auth);
    }),

    vscode.commands.registerCommand('sentry.viewLogs', () => showLog()),

    vscode.commands.registerCommand('sentry.clearLogs', async () => {
      await clearLog();
      vscode.window.setStatusBarMessage('Sentry: debug log cleared', 3000);
    }),

    vscode.commands.registerCommand('sentry.initWorkspaceConfig', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) {
        void vscode.window.showWarningMessage('Open a folder before creating a .sentry_viewer config.');
        return;
      }
      const folder =
        folders.length === 1
          ? folders[0]
          : (
              await vscode.window.showQuickPick(
                folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
                { title: 'Create .sentry_viewer in which folder?' },
              )
            )?.folder;
      if (!folder) return;

      let organization = config.get().organization;
      let project = config.get().project;
      if (await auth.isSignedIn()) {
        try {
          const orgs = await client.listOrganizations();
          const orgPick = await vscode.window.showQuickPick(
            orgs.map((o) => o.slug),
            { title: 'Sentry organization', placeHolder: organization || undefined },
          );
          if (!orgPick) return;
          organization = orgPick;
          const previousOrg = config.get().organization;
          if (orgPick !== previousOrg) {
            // listProjects uses the configured org; ask against the picked one via a temp query.
            log(`Scaffolding with org ${orgPick}`);
          }
          const projects = await client.listProjects().catch(() => []);
          const projectPick = await vscode.window.showQuickPick(
            [...projects.map((p) => p.slug), '$(edit) Enter manually…'],
            { title: 'Sentry project', placeHolder: project || undefined },
          );
          if (!projectPick) return;
          project =
            projectPick === '$(edit) Enter manually…'
              ? (await vscode.window.showInputBox({ title: 'Sentry project slug', value: project })) ?? ''
              : projectPick;
          if (!project) return;
        } catch (e) {
          log(`initWorkspaceConfig: falling back to manual entry: ${e}`);
        }
      }
      if (!organization) {
        organization = (await vscode.window.showInputBox({ title: 'Sentry organization slug', ignoreFocusOut: true })) ?? '';
        if (!organization) return;
      }
      if (!project) {
        project = (await vscode.window.showInputBox({ title: 'Sentry project slug', ignoreFocusOut: true })) ?? '';
        if (!project) return;
      }
      const configFile = await config.scaffold(folder, { organization, project, baseUrl: config.get().baseUrl });
      await vscode.window.showTextDocument(vscode.Uri.file(configFile));
      await refreshAll();
    }),

    vscode.commands.registerCommand('sentry.selectWorkspaceConfig', async () => {
      const info = config.workspaceInfo();
      if (info.allFolders.length < 2) {
        void vscode.window.showInformationMessage('Only one .sentry_viewer config found in this workspace.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        info.allFolders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { title: 'Use .sentry_viewer config from…' },
      );
      if (picked) {
        await config.setActiveFolder(picked.folder);
        await refreshAll();
      }
    }),
  );

  /* Cross-cutting wiring */
  const updateConfiguredContext = () =>
    vscode.commands.executeCommand('setContext', 'sentry.configured', config.isConfigured());

  const refreshAll = async () => {
    await auth.updateContextKey();
    await updateConfiguredContext();
    if ((await auth.isSignedIn()) && config.isConfigured()) {
      await store.refresh();
    }
  };

  context.subscriptions.push(
    config.onDidChange(() => {
      syncLogDirectory();
      memberCache.invalidate();
      void refreshAll();
    }),
    auth.onDidChange(() => void refreshAll()),
  );

  await vscode.commands.executeCommand('setContext', 'sentry.filtersActive', store.filterDescription() !== '');
  await refreshAll();
  log('Sentry Viewer activated');
  return { store, config };
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
