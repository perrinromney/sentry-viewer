import type { DetailFromWebview, DetailToWebview, IssueDetailViewModel } from '../shared/messages';

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

function post(message: DetailFromWebview): void {
  vscode.postMessage(message);
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function relative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function render(vm: IssueDetailViewModel): void {
  root.className = '';
  root.textContent = '';

  const header = el('div', 'header');
  const titleRow = el('div', 'title-row');
  titleRow.append(el('span', `level ${vm.level}`), el('span', 'title', vm.title), el('span', 'short-id', vm.shortId));
  header.append(titleRow);

  const meta = el('div', 'meta');
  meta.append(
    el('span', undefined, `${vm.status}${vm.assignee ? ` · assigned to ${vm.assignee}` : ' · unassigned'}`),
    el('span', undefined, `${vm.count} events · ${vm.userCount} users`),
    el('span', undefined, `first seen ${relative(vm.firstSeen)} · last seen ${relative(vm.lastSeen)}`),
  );
  if (vm.culprit) meta.append(el('span', undefined, vm.culprit));
  header.append(meta);

  const actions = el('div', 'actions');
  const addButton = (label: string, onClick: () => void, secondary = false) => {
    const button = el('button', secondary ? 'secondary' : undefined, label) as HTMLButtonElement;
    button.addEventListener('click', onClick);
    actions.append(button);
  };
  if (vm.status !== 'resolved') addButton('Resolve', () => post({ type: 'action', issueId: vm.issueId, action: 'resolve' }));
  if (vm.status === 'unresolved') {
    addButton('Resolve in Next Release', () => post({ type: 'action', issueId: vm.issueId, action: 'resolveNextRelease' }), true);
    addButton('Archive', () => post({ type: 'action', issueId: vm.issueId, action: 'archive' }), true);
  }
  if (vm.status !== 'unresolved') {
    addButton(vm.status === 'ignored' ? 'Unarchive' : 'Unresolve', () => post({ type: 'action', issueId: vm.issueId, action: 'unresolve' }), true);
  }
  addButton('Assign…', () => post({ type: 'action', issueId: vm.issueId, action: 'assign' }), true);
  addButton('Open in Sentry ↗', () => post({ type: 'openInBrowser', issueId: vm.issueId }), true);
  header.append(actions);
  root.append(header);

  if (vm.frames.length > 0) {
    const section = el('section');
    section.append(el('h3', undefined, 'Stack Trace (innermost first)'));
    const frames = el('div', 'frames');
    for (const frame of vm.frames) {
      const row = el('div', `frame ${frame.resolvable ? 'resolvable' : 'unresolvable'}`);
      const pathSpan = el('span', 'path', `${frame.display}${frame.lineNo ? `:${frame.lineNo}` : ''}`);
      row.append(pathSpan);
      if (frame.functionName) row.append(el('span', 'fn', `  ${frame.functionName}`));
      if (!frame.resolvable && /assets\/[\w.-]+\.js/.test(frame.display)) {
        row.append(el('span', 'hint', '  (minified — no sourcemap)'));
      }
      if (frame.resolvable) {
        row.title = 'Open in editor';
        row.addEventListener('click', () => post({ type: 'openFrame', issueId: vm.issueId, frameIndex: frame.frameIndex }));
      }
      frames.append(row);
    }
    section.append(frames);
    root.append(section);
  }

  if (vm.tags.length > 0) {
    const section = el('section');
    section.append(el('h3', undefined, 'Tags'));
    const table = el('table');
    for (const tag of vm.tags) {
      const tr = el('tr');
      tr.append(el('td', 'key', tag.key), el('td', undefined, tag.value));
      table.append(tr);
    }
    section.append(table);
    root.append(section);
  }

  if (vm.contexts.length > 0) {
    const section = el('section');
    section.append(el('h3', undefined, 'Context'));
    const table = el('table');
    for (const ctx of vm.contexts) {
      const tr = el('tr');
      tr.append(el('td', 'key', ctx.key), el('td', undefined, ctx.value));
      table.append(tr);
    }
    section.append(table);
    root.append(section);
  }

  if (vm.breadcrumbs.length > 0) {
    const section = el('section');
    section.append(el('h3', undefined, `Breadcrumbs (last ${vm.breadcrumbs.length})`));
    const crumbs = el('div', 'crumbs');
    for (const crumb of vm.breadcrumbs) {
      const row = el('div', 'crumb');
      row.append(el('span', 'cat', crumb.category), el('span', 'msg', crumb.message));
      if (crumb.timestamp) row.append(el('span', 'ts', new Date(crumb.timestamp).toLocaleTimeString()));
      crumbs.append(row);
    }
    section.append(crumbs);
    root.append(section);
  }
}

window.addEventListener('message', (event: MessageEvent<DetailToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'showIssue':
      render(message.vm);
      break;
    case 'loading':
      root.className = 'empty';
      root.textContent = `Loading ${message.title}…`;
      break;
    case 'clear':
      root.className = 'empty';
      root.textContent = 'Select a Sentry issue to see details.';
      break;
    case 'error':
      root.className = 'empty';
      root.textContent = message.message;
      break;
  }
});

post({ type: 'ready' });
