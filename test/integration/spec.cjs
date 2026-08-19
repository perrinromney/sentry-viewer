/**
 * Headless integration test, run inside a real VS Code extension host via
 * `code --extensionTestsPath`. The workspace folder is expected to contain a
 * .sentry_viewer config pointing at a real org/project (with a token override
 * in local.json), so this exercises activation, workspace config resolution,
 * auth, a live refresh, filtering, and event fetching end-to-end.
 */
const vscode = require('vscode');
const fs = require('fs');

const RESULT_FILE = process.env.SENTRY_TEST_RESULT_FILE;
const results = [];

function check(name, ok, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`${name}: ${detail ?? 'failed'}`);
}

function waitFor(label, predicate, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if (predicate()) {
          clearInterval(timer);
          resolve(undefined);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${label}`));
        }
      } catch (e) {
        clearInterval(timer);
        reject(e);
      }
    }, 250);
  });
}

exports.run = async function run() {
  try {
    const ext = vscode.extensions.getExtension('allucent.sentry-viewer');
    check('extension found', Boolean(ext));
    const api = await ext.activate();
    check('activate() returns api', Boolean(api && api.store && api.config));

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'sentry.signIn',
      'sentry.refresh',
      'sentry.search',
      'sentry.filter',
      'sentry.openSettings',
      'sentry.resolveIssue',
      'sentry.archiveIssue',
      'sentry.assignIssue',
      'sentry.initWorkspaceConfig',
      'sentry.toggleFileFilter',
    ]) {
      check(`command registered: ${id}`, commands.includes(id));
    }

    const cfg = api.config.get();
    check('workspace config picked up', cfg.organization === 'allucent' && cfg.project === 'allucent-main-app',
      `org=${cfg.organization} project=${cfg.project}`);
    check('token override from local.json', cfg.provenance && Boolean(api.config.workspaceInfo().hasLocal));

    await waitFor('initial refresh to load issues', () => api.store.issues.length > 0);
    check('issues loaded', api.store.issues.length > 0, `${api.store.issues.length} issues`);
    check('badge count set', api.store.openCount > 0, `openCount=${api.store.openCount}`);

    await waitFor('latest events prefetched', () => api.store.events.size >= Math.min(3, api.store.issues.length), 45000);
    check('events prefetched', api.store.events.size > 0, `${api.store.events.size} events cached`);

    const before = api.store.visibleIssues().length;
    await api.store.setFilter({ clientText: 'zzz-no-such-issue-zzz' });
    check('client text filter narrows to zero', api.store.visibleIssues().length === 0, `before=${before}`);
    await api.store.setFilter({ clientText: '' });
    check('clearing text filter restores', api.store.visibleIssues().length === before);

    await api.store.setFilter({ serverTags: { environment: 'production' } });
    await waitFor('server-side tag filter refresh', () => !api.store.loading, 30000);
    check('server tag filter applied without error', api.store.lastError === undefined, api.store.lastError);
    check('badge unaffected by filter', api.store.openCount > 0, `openCount=${api.store.openCount}`);
    await api.store.clearFilters();
    await waitFor('filters cleared refresh', () => !api.store.loading, 30000);
    check('filter description empty after clear', api.store.filterDescription() === '');

    const archivedPromise = api.store.loadArchived();
    await archivedPromise;
    check('archived section loads', api.store.archivedLoaded && api.store.archived.length > 0,
      `${api.store.archived.length} archived`);

    results.push('ALL OK');
  } finally {
    if (RESULT_FILE) fs.writeFileSync(RESULT_FILE, results.join('\n') + '\n');
  }
};
