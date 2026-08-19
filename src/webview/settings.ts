import type { SettingsFromWebview, SettingsScope, SettingsToWebview, SettingsViewModel } from '../shared/messages';

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
let statusLine: HTMLElement | undefined;

/**
 * Fields the user has edited since the last save. Re-renders (triggered by
 * any state push from the extension) restore these from the live DOM instead
 * of the saved config, so typing is never wiped by a refresh.
 */
const dirty = new Set<string>();
let mappingsDirty = false;
let preserved: Record<string, string | boolean> = {};

function markDirty(input: HTMLInputElement | HTMLSelectElement): void {
  input.addEventListener(input instanceof HTMLSelectElement || input.type === 'checkbox' ? 'change' : 'input', () =>
    dirty.add(input.id),
  );
}

function snapshotDirty(): void {
  preserved = {};
  for (const id of dirty) {
    const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!node) continue;
    preserved[id] = node instanceof HTMLInputElement && node.type === 'checkbox' ? node.checked : node.value;
  }
  const scope = document.querySelector<HTMLInputElement>('input[name="scope"]:checked');
  if (scope) preserved['__scope'] = scope.value;
}

function post(message: SettingsFromWebview): void {
  vscode.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sourceLabel(source: string): string {
  const names: Record<string, string> = {
    'workspace-local': '.sentry_viewer/local.json',
    workspace: '.sentry_viewer/config.json',
    settings: 'VS Code settings',
    'sentry-cli': '~/.sentryclirc',
    default: 'default',
  };
  return names[source] ?? source;
}

function textRow(label: string, id: string, value: string, source?: string, datalistValues?: string[]): HTMLElement {
  const row = el('div', 'row');
  const labelEl = el('label', 'field', label);
  labelEl.htmlFor = id;
  const input = el('input');
  input.type = 'text';
  input.id = id;
  input.value = typeof preserved[id] === 'string' ? (preserved[id] as string) : value;
  markDirty(input);
  if (datalistValues?.length) {
    const listId = `${id}-list`;
    const datalist = el('datalist');
    datalist.id = listId;
    for (const v of datalistValues) {
      const option = el('option');
      option.value = v;
      datalist.append(option);
    }
    input.setAttribute('list', listId);
    row.append(datalist);
  }
  row.append(labelEl, input);
  if (source) row.append(el('span', 'provenance', `from ${sourceLabel(source)}`));
  return row;
}

function checkbox(label: string, id: string, checked: boolean): HTMLElement {
  const wrap = el('label', undefined);
  const input = el('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = typeof preserved[id] === 'boolean' ? (preserved[id] as boolean) : checked;
  markDirty(input);
  wrap.append(input, document.createTextNode(` ${label}`));
  return wrap;
}

function val(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value.trim();
}

function isChecked(id: string): boolean {
  return (document.getElementById(id) as HTMLInputElement).checked;
}

function collectMappings(): Record<string, string> {
  const mappings: Record<string, string> = {};
  for (const row of document.querySelectorAll<HTMLElement>('.mapping-row')) {
    const inputs = row.querySelectorAll('input');
    const from = inputs[0].value.trim();
    const to = inputs[1].value.trim();
    if (from && to) mappings[from] = to;
  }
  return mappings;
}

function mappingRow(from = '', to = ''): HTMLElement {
  const row = el('div', 'row mapping-row');
  const fromInput = el('input');
  fromInput.type = 'text';
  fromInput.placeholder = 'sentry prefix e.g. src/';
  fromInput.value = from;
  const toInput = el('input');
  toInput.type = 'text';
  toInput.placeholder = 'workspace prefix e.g. app/src/';
  toInput.value = to;
  for (const input of [fromInput, toInput]) input.addEventListener('input', () => (mappingsDirty = true));
  const remove = el('button', 'secondary', '✕');
  remove.addEventListener('click', () => {
    mappingsDirty = true;
    row.remove();
  });
  row.append(fromInput, el('span', undefined, '→'), toInput, remove);
  return row;
}

function render(model: SettingsViewModel): void {
  snapshotDirty();
  const preservedMappings = mappingsDirty ? collectMappings() : undefined;
  root.textContent = '';

  /* Connection */
  const connection = el('fieldset');
  connection.append(el('legend', undefined, 'Connection'));
  connection.append(textRow('Base URL', 'baseUrl', model.baseUrl.value, model.baseUrl.source));
  connection.append(textRow('Organization', 'organization', model.organization.value, model.organization.source, model.organizations));
  connection.append(textRow('Project', 'project', model.project.value, model.project.source, model.projects));

  const optionsRow = el('div', 'row');
  const loadButton = el('button', 'secondary', model.organizations ? 'Reload org/project suggestions' : 'Load org/project suggestions');
  loadButton.addEventListener('click', () => {
    setStatus('Loading suggestions…', false);
    post({ type: 'loadOptions', organization: val('organization'), baseUrl: val('baseUrl') });
  });
  optionsRow.append(loadButton);
  if (model.organizations) {
    optionsRow.append(
      el('span', 'note', `${model.organizations.length} org${model.organizations.length === 1 ? '' : 's'}, ${model.projects?.length ?? 0} projects loaded — suggestions appear as you type in the fields above`),
    );
  }
  connection.append(optionsRow);

  const tokenRow = el('div', 'row');
  const tokenText = {
    'workspace-override': 'Token: workspace override (.sentry_viewer/local.json)',
    'secret-storage': 'Token: stored in VS Code SecretStorage',
    none: 'Token: not set — sign in required',
  }[model.tokenStatus];
  tokenRow.append(el('span', model.tokenStatus === 'none' ? 'warn' : undefined, tokenText));
  const changeToken = el('button', 'secondary', 'Set Token…');
  changeToken.addEventListener('click', () => post({ type: 'setToken', scope: 'secret-storage' }));
  tokenRow.append(changeToken);
  if (model.cliTokenAvailable) {
    const importButton = el('button', 'secondary', 'Import from sentry-cli');
    importButton.addEventListener('click', () => post({ type: 'importCliToken' }));
    tokenRow.append(importButton);
  }
  if (model.workspace.hasFolder) {
    const overrideButton = el('button', 'secondary', 'Set Workspace Token Override…');
    overrideButton.addEventListener('click', () => post({ type: 'setToken', scope: 'workspace' }));
    tokenRow.append(overrideButton);
  }
  const testButton = el('button', undefined, 'Test Connection');
  testButton.addEventListener('click', () => {
    setStatus('Testing connection…', false);
    post({ type: 'testConnection', organization: val('organization'), project: val('project'), baseUrl: val('baseUrl') });
  });
  tokenRow.append(testButton);
  connection.append(tokenRow);
  root.append(connection);

  /* Workspace */
  const workspace = el('fieldset');
  workspace.append(el('legend', undefined, 'Workspace (.sentry_viewer/)'));
  const wsRow = el('div', 'row');
  if (model.workspace.configPath) {
    wsRow.append(el('span', undefined, `Config: ${model.workspace.configPath}`));
    const openButton = el('button', 'secondary', 'Open config.json');
    openButton.addEventListener('click', () => post({ type: 'openConfigFile' }));
    wsRow.append(openButton);
  } else if (model.workspace.hasFolder) {
    wsRow.append(el('span', undefined, 'No .sentry_viewer config in this workspace.'));
    const createButton = el('button', 'secondary', 'Create…');
    createButton.addEventListener('click', () => post({ type: 'createWorkspaceConfig' }));
    wsRow.append(createButton);
  } else {
    wsRow.append(el('span', undefined, 'No workspace folder open.'));
  }
  workspace.append(wsRow);
  if (model.workspace.hasLocal && !model.workspace.localGitignored) {
    workspace.append(el('div', 'note warn', '⚠ .sentry_viewer/local.json exists but is not covered by .sentry_viewer/.gitignore — a token override could be committed.'));
  }
  workspace.append(textRow('Default query', 'defaultQuery', model.defaultQuery.value, model.defaultQuery.source));
  workspace.append(el('div', 'note', 'Default query is appended to every server-side issue search (e.g. release:latest).'));
  root.append(workspace);

  /* Behavior */
  const behavior = el('fieldset');
  behavior.append(el('legend', undefined, 'Behavior (saved to user settings)'));
  const statsRow = el('div', 'row');
  const statsLabel = el('label', 'field', 'Stats period');
  statsLabel.htmlFor = 'statsPeriod';
  const statsSelect = el('select');
  statsSelect.id = 'statsPeriod';
  const statsCurrent = typeof preserved.statsPeriod === 'string' ? preserved.statsPeriod : model.statsPeriod.value;
  for (const period of ['24h', '7d', '14d', '30d', '90d']) {
    const option = el('option', undefined, period);
    option.value = period;
    option.selected = period === statsCurrent;
    statsSelect.append(option);
  }
  markDirty(statsSelect);
  statsRow.append(statsLabel, statsSelect, el('span', 'provenance', `from ${sourceLabel(model.statsPeriod.source)}`));
  behavior.append(statsRow);

  const pollRow = el('div', 'row');
  const pollLabel = el('label', 'field', 'Poll interval (s)');
  pollLabel.htmlFor = 'pollIntervalSeconds';
  const pollInput = el('input');
  pollInput.type = 'number';
  pollInput.id = 'pollIntervalSeconds';
  pollInput.min = '0';
  pollInput.value =
    typeof preserved.pollIntervalSeconds === 'string' ? preserved.pollIntervalSeconds : String(model.pollIntervalSeconds);
  markDirty(pollInput);
  pollRow.append(pollLabel, pollInput);
  behavior.append(pollRow);

  const togglesRow = el('div', 'row');
  togglesRow.append(checkbox('Open code on select', 'openCodeOnSelect', model.openCodeOnSelect));
  behavior.append(togglesRow);
  const inlineRow = el('div', 'row');
  inlineRow.append(
    el('span', 'field', 'Inline:'),
    checkbox('CodeLens', 'inlineCodeLens', model.inline.codeLens),
    checkbox('Decorations', 'inlineDecorations', model.inline.decorations),
    checkbox('Hovers', 'inlineHovers', model.inline.hovers),
    checkbox('Status bar', 'inlineStatusBar', model.inline.statusBar),
  );
  behavior.append(inlineRow);
  root.append(behavior);

  /* Path mappings */
  const mappings = el('fieldset');
  mappings.append(el('legend', undefined, 'Path Mappings'));
  mappings.append(el('div', 'note', 'Map Sentry stack-frame path prefixes to workspace-relative prefixes when suffix matching is not enough.'));
  const mappingList = el('div');
  mappingList.id = 'mappingList';
  for (const [from, to] of Object.entries(preservedMappings ?? model.pathMappings.value)) {
    mappingList.append(mappingRow(from, to));
  }
  mappings.append(mappingList);
  const addRow = el('div', 'row');
  const addButton = el('button', 'secondary', '+ Add mapping');
  addButton.addEventListener('click', () => {
    mappingsDirty = true;
    mappingList.append(mappingRow());
  });
  addRow.append(addButton, el('span', 'provenance', `from ${sourceLabel(model.pathMappings.source)}`));
  mappings.append(addRow);
  root.append(mappings);

  /* Diagnostics */
  const diagnostics = el('fieldset');
  diagnostics.append(el('legend', undefined, 'Diagnostics'));
  const logRow = el('div', 'row');
  if (model.log.path) {
    const kb = (model.log.sizeBytes / 1024).toFixed(1);
    logRow.append(el('span', undefined, `Debug log: ${model.log.path} (${kb} KB)`));
  } else {
    logRow.append(
      el('span', 'note', 'Debug log file is written once a .sentry_viewer config exists; until then, logs go to the "Sentry" output channel.'),
    );
  }
  const viewLogButton = el('button', 'secondary', 'View Log');
  viewLogButton.addEventListener('click', () => post({ type: 'viewLogs' }));
  const clearLogButton = el('button', 'secondary', 'Clear Log');
  clearLogButton.addEventListener('click', () => post({ type: 'clearLogs' }));
  logRow.append(viewLogButton, clearLogButton);
  diagnostics.append(logRow);
  diagnostics.append(el('div', 'note', 'The log is gitignored and safe to copy/paste for debugging — auth tokens are redacted.'));
  root.append(diagnostics);

  /* Save bar */
  const saveBar = el('div', 'savebar');
  const scopeWrap = el('span');
  scopeWrap.append(el('span', undefined, 'Save connection to: '));
  const scopes: { id: SettingsScope; label: string; disabled?: boolean }[] = [
    { id: 'workspace', label: 'Workspace .sentry_viewer', disabled: !model.workspace.hasFolder },
    { id: 'user', label: 'User settings' },
  ];
  const scopeCurrent =
    typeof preserved['__scope'] === 'string' ? preserved['__scope'] : model.workspace.hasFolder ? 'workspace' : 'user';
  for (const scope of scopes) {
    const label = el('label');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'scope';
    radio.value = scope.id;
    radio.disabled = Boolean(scope.disabled);
    radio.checked = scope.id === scopeCurrent && !scope.disabled;
    label.append(radio, document.createTextNode(` ${scope.label}  `));
    scopeWrap.append(label);
  }
  saveBar.append(scopeWrap);
  const saveButton = el('button', undefined, 'Save');
  saveButton.addEventListener('click', () => {
    const scope = (document.querySelector('input[name="scope"]:checked') as HTMLInputElement | null)?.value as SettingsScope | undefined;
    setStatus('Saving…', false);
    post({
      type: 'save',
      scope: scope ?? 'user',
      changes: {
        baseUrl: val('baseUrl'),
        organization: val('organization'),
        project: val('project'),
        statsPeriod: (document.getElementById('statsPeriod') as HTMLSelectElement).value,
        defaultQuery: val('defaultQuery'),
        pathMappings: collectMappings(),
        pollIntervalSeconds: Number(val('pollIntervalSeconds')) || 0,
        openCodeOnSelect: isChecked('openCodeOnSelect'),
        inline: {
          codeLens: isChecked('inlineCodeLens'),
          decorations: isChecked('inlineDecorations'),
          hovers: isChecked('inlineHovers'),
          statusBar: isChecked('inlineStatusBar'),
        },
      },
    });
  });
  saveBar.append(saveButton);
  statusLine = el('span', 'note');
  saveBar.append(statusLine);
  root.append(saveBar);
}

function setStatus(text: string, isWarn: boolean): void {
  if (!statusLine) return;
  statusLine.textContent = text;
  statusLine.className = isWarn ? 'note warn' : 'note';
}

window.addEventListener('message', (event: MessageEvent<SettingsToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'state':
      render(message.vm);
      break;
    case 'saved':
      dirty.clear();
      mappingsDirty = false;
      preserved = {};
      setStatus('Saved ✓', false);
      break;
    case 'testResult':
      setStatus(message.message, !message.ok);
      break;
  }
});

post({ type: 'ready' });
export {};
