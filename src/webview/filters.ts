import type { FiltersFromWebview, FiltersToWebview, FilterViewModel } from '../shared/messages';

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

let pendingVm: FilterViewModel | undefined;

function post(message: FiltersFromWebview): void {
  vscode.postMessage(message);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** True while the user is interacting with a control inside the view. */
function isEditing(): boolean {
  const active = document.activeElement;
  return Boolean(active && root.contains(active) && (active instanceof HTMLInputElement || active instanceof HTMLSelectElement));
}

function select(id: string, options: { label: string; value: string }[], current: string, onChange: (value: string) => void): HTMLSelectElement {
  const node = el('select');
  node.id = id;
  for (const option of options) {
    const o = el('option', undefined, option.label);
    o.value = option.value;
    o.selected = option.value === current;
    node.append(o);
  }
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function chip(label: string, title: string, onRemove: () => void): HTMLElement {
  const node = el('span', 'chip');
  node.title = title;
  node.append(el('span', 'chip-label', label));
  const x = el('button', 'chip-x', '✕');
  x.title = `Remove ${title}`;
  x.addEventListener('click', onRemove);
  node.append(x);
  return node;
}

function render(vm: FilterViewModel): void {
  root.textContent = '';

  if (!vm.enabled) {
    root.append(el('div', 'empty', vm.disabledReason ?? 'Sentry is not configured.'));
    return;
  }

  /* Search (server-side Sentry syntax) */
  const searchRow = el('div', 'frow');
  const search = el('input');
  search.type = 'text';
  search.id = 'rawQuery';
  search.placeholder = 'Search (Sentry syntax): error.type:TypeError …';
  search.value = vm.rawQuery;
  search.title = 'Server-side Sentry search syntax. Press Enter to apply.';
  const commitSearch = () => {
    if (search.value.trim() !== vm.rawQuery) post({ type: 'set', patch: { rawQuery: search.value } });
  };
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitSearch();
  });
  search.addEventListener('blur', commitSearch);
  searchRow.append(search);
  root.append(searchRow);

  /* Text filter (client-side, live) */
  const textRow = el('div', 'frow');
  const text = el('input');
  text.type = 'text';
  text.id = 'clientText';
  text.placeholder = 'Filter by title text (instant)';
  text.value = vm.clientText;
  const commitText = debounce(() => post({ type: 'set', patch: { clientText: text.value } }), 300);
  text.addEventListener('input', commitText);
  textRow.append(text);
  root.append(textRow);

  /* Status + assigned */
  const statusRow = el('div', 'frow two');
  statusRow.append(
    select(
      'status',
      [
        { label: 'Unresolved', value: 'unresolved' },
        { label: 'Archived', value: 'ignored' },
        { label: 'Resolved', value: 'resolved' },
        { label: 'All statuses', value: 'all' },
      ],
      vm.status,
      (value) => post({ type: 'set', patch: { status: value as FilterViewModel['status'] } }),
    ),
    select(
      'assigned',
      [
        { label: 'Any assignee', value: '' },
        { label: 'Assigned to me', value: 'me' },
        { label: 'Unassigned', value: 'none' },
        ...vm.assignees,
      ],
      vm.assigned,
      (value) => post({ type: 'set', patch: { assigned: value } }),
    ),
  );
  root.append(statusRow);

  /* Add tag/context filter */
  const addRow = el('div', 'frow add-filter');
  const fieldOptions = [
    ...vm.fields.map((f) => ({ label: f.tier === 'context' ? `${f.name} (context)` : f.name, value: `${f.tier}:${f.name}` })),
    { label: 'custom tag…', value: 'tag:' },
    { label: 'custom context…', value: 'context:' },
  ];
  let currentField = fieldOptions[0].value;
  const customField = el('input');
  customField.type = 'text';
  customField.id = 'customField';
  customField.placeholder = 'field name';
  customField.style.display = 'none';

  const valueInput = el('input');
  valueInput.type = 'text';
  valueInput.id = 'filterValue';
  valueInput.placeholder = 'value…';
  const datalist = el('datalist');
  datalist.id = 'value-suggestions';
  valueInput.setAttribute('list', datalist.id);

  const refreshSuggestions = () => {
    datalist.textContent = '';
    const [, name] = currentField.split(':');
    for (const value of vm.suggestions[name] ?? []) {
      const option = el('option');
      option.value = value;
      datalist.append(option);
    }
  };

  const fieldSelect = select('filterField', fieldOptions, currentField, (value) => {
    currentField = value;
    const isCustom = value.endsWith(':');
    customField.style.display = isCustom ? '' : 'none';
    refreshSuggestions();
  });
  refreshSuggestions();

  const add = () => {
    const [tier, presetName] = currentField.split(':') as ['tag' | 'context', string];
    const field = presetName || customField.value.trim();
    if (!field || !valueInput.value.trim()) return;
    post({ type: 'addFilter', tier, field, value: valueInput.value });
    valueInput.value = '';
    customField.value = '';
  };
  valueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  const addButton = el('button', 'secondary', '+');
  addButton.title = 'Add filter';
  addButton.addEventListener('click', add);

  addRow.append(fieldSelect, customField, valueInput, datalist, addButton);
  root.append(addRow);

  /* Active filter chips */
  const chips = el('div', 'chips');
  for (const [key, value] of Object.entries(vm.serverTags)) {
    chips.append(chip(`${key}:${value}`, `server tag ${key}`, () => post({ type: 'removeFilter', kind: 'tag', key })));
  }
  for (const [key, value] of Object.entries(vm.clientContexts)) {
    chips.append(chip(`${key}~${value}`, `context ${key} (client-side)`, () => post({ type: 'removeFilter', kind: 'context', key })));
  }
  if (vm.fileName) {
    chips.append(chip(`file:${vm.fileName}`, 'active file filter', () => post({ type: 'removeFilter', kind: 'file' })));
  }
  if (chips.childElementCount > 0) root.append(chips);

  /* Footer: counts + clear */
  const footer = el('div', 'frow footer');
  const filtered =
    vm.visibleCount !== vm.totalCount ||
    chips.childElementCount > 0 ||
    vm.rawQuery !== '' ||
    vm.clientText !== '' ||
    vm.assigned !== '' ||
    vm.status !== 'unresolved';
  footer.append(el('span', 'note', `${vm.visibleCount} of ${vm.totalCount} shown`));
  if (filtered) {
    const clear = el('button', 'secondary', 'Clear all');
    clear.addEventListener('click', () => post({ type: 'clearAll' }));
    footer.append(clear);
  }
  root.append(footer);
}

window.addEventListener('message', (event: MessageEvent<FiltersToWebview>) => {
  if (event.data.type !== 'state') return;
  // Never yank the DOM out from under the user's cursor/keyboard — defer
  // re-renders until they leave the control they're editing.
  if (isEditing()) {
    pendingVm = event.data.vm;
    return;
  }
  render(event.data.vm);
});

root.addEventListener('focusout', () => {
  // Let the blur commit handlers run first, then apply any deferred state.
  setTimeout(() => {
    if (pendingVm && !isEditing()) {
      const vm = pendingVm;
      pendingVm = undefined;
      render(vm);
    }
  }, 150);
});

post({ type: 'ready' });
export {};
