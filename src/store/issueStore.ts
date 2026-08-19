import * as vscode from 'vscode';
import { ConfigService } from '../config/workspaceConfig';
import { SentryClient } from '../sentry/client';
import {
  buildClientPredicate,
  buildServerQuery,
  DEFAULT_FILTER,
  describeFilter,
  FilterState,
  isDefaultFilter,
} from '../sentry/query';
import { Issue, IssueUpdate, SentryApiError, SentryEvent } from '../sentry/types';
import { log } from '../util/log';

const FILTER_STATE_KEY = 'sentry.filterState';
const EVENT_PREFETCH_LIMIT = 50;
const PREFETCH_CONCURRENCY = 4;

export class IssueStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeSelection = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeSelection = this._onDidChangeSelection.event;

  issues: Issue[] = [];
  archived: Issue[] = [];
  archivedLoaded = false;
  nextCursor: string | undefined;
  archivedCursor: string | undefined;
  readonly events = new Map<string, SentryEvent>();
  filter: FilterState;
  openCount = 0;
  openCountIsPartial = false;
  loading = false;
  lastError: string | undefined;
  selectedIssueId: string | undefined;

  /** Injected by the extension: fsPath -> issue ids with a frame in that file (for the file filter). */
  fileIssueLookup: (fsPath: string) => Set<string> = () => new Set();

  private projectId: string | undefined;
  private projectIdFor: string | undefined;
  private epoch = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private backoffUntil = 0;
  private pollingPaused = false;
  private lastRefreshAt = 0;
  private fireHandle: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly client: SentryClient,
    private readonly config: ConfigService,
    private readonly state: vscode.Memento,
  ) {
    this.filter = { ...DEFAULT_FILTER, ...state.get<Partial<FilterState>>(FILTER_STATE_KEY, {}) };
    this.disposables.push(
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused && Date.now() - this.lastRefreshAt > 30_000 && !this.pollingPaused) {
          void this.refresh();
        }
      }),
    );
    this.restartPolling();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sentry.pollIntervalSeconds')) this.restartPolling();
      }),
    );
  }

  private fireChanged(): void {
    // Coalesce bursts (e.g. events streaming in during prefetch).
    if (this.fireHandle) return;
    this.fireHandle = setTimeout(() => {
      this.fireHandle = undefined;
      this._onDidChange.fire();
    }, 100);
  }

  visibleIssues(): Issue[] {
    const predicate = buildClientPredicate(this.filter);
    let result = this.issues.filter((issue) => predicate(issue, this.events.get(issue.id)));
    if (this.filter.file) {
      const ids = this.fileIssueLookup(this.filter.file);
      result = result.filter((issue) => ids.has(issue.id));
    }
    return result;
  }

  /** Issues for the inline location index: client-filtered but ignoring the file criterion. */
  issuesForLocationIndex(): Issue[] {
    const predicate = buildClientPredicate(this.filter);
    return this.issues.filter((issue) => predicate(issue, this.events.get(issue.id)));
  }

  filterDescription(): string {
    return describeFilter(this.filter);
  }

  getIssue(id: string): Issue | undefined {
    return this.issues.find((i) => i.id === id) ?? this.archived.find((i) => i.id === id);
  }

  select(issueId: string | undefined): void {
    this.selectedIssueId = issueId;
    this._onDidChangeSelection.fire(issueId);
  }

  async setFilter(update: Partial<FilterState>): Promise<void> {
    const previousServerQuery = buildServerQuery(this.filter);
    this.filter = { ...this.filter, ...update };
    await this.state.update(FILTER_STATE_KEY, this.filter);
    void vscode.commands.executeCommand('setContext', 'sentry.filtersActive', !isDefaultFilter(this.filter));
    if (buildServerQuery(this.filter) !== previousServerQuery) {
      await this.refresh();
    } else {
      this.fireChanged();
    }
  }

  async clearFilters(): Promise<void> {
    await this.setFilter({ ...DEFAULT_FILTER });
  }

  private async resolveProjectId(): Promise<string | undefined> {
    const cfg = this.config.get();
    if (!cfg.project) return undefined;
    const key = `${cfg.baseUrl}/${cfg.organization}/${cfg.project}`;
    if (this.projectId && this.projectIdFor === key) return this.projectId;
    const projects = await this.client.listProjects();
    const match = projects.find((p) => p.slug === cfg.project || p.id === cfg.project);
    if (!match) throw new SentryApiError(`Project "${cfg.project}" not found in org "${cfg.organization}"`, 404);
    this.projectId = match.id;
    this.projectIdFor = key;
    return this.projectId;
  }

  private composedQuery(base: string): string {
    const extra = this.config.get().defaultQuery.trim();
    return extra ? `${base} ${extra}`.trim() : base;
  }

  async refresh(): Promise<void> {
    if (!this.config.isConfigured()) return;
    const myEpoch = ++this.epoch;
    this.loading = true;
    this.lastError = undefined;
    this.fireChanged();
    try {
      const cfg = this.config.get();
      const projectId = await this.resolveProjectId();
      const query = this.composedQuery(buildServerQuery(this.filter));
      const { issues, nextCursor } = await this.client.listIssues({
        projectId,
        query,
        statsPeriod: cfg.statsPeriod,
      });
      if (myEpoch !== this.epoch) return; // stale response
      this.issues = issues;
      this.nextCursor = nextCursor;
      this.lastRefreshAt = Date.now();

      const baselineQuery = this.composedQuery('is:unresolved');
      if (query === baselineQuery) {
        this.openCount = issues.length;
        this.openCountIsPartial = Boolean(nextCursor);
      } else {
        const baseline = await this.client.listIssues({ projectId, query: baselineQuery, statsPeriod: cfg.statsPeriod });
        if (myEpoch !== this.epoch) return;
        this.openCount = baseline.issues.length;
        this.openCountIsPartial = Boolean(baseline.nextCursor);
      }
      this.backoffUntil = 0;
      this.fireChanged();
      void this.prefetchEvents(myEpoch);
      if (this.archivedLoaded) void this.loadArchived(true);
    } catch (e) {
      if (myEpoch !== this.epoch) return;
      this.handleError(e);
    } finally {
      if (myEpoch === this.epoch) {
        this.loading = false;
        this.fireChanged();
      }
    }
  }

  async loadMore(): Promise<void> {
    if (!this.nextCursor) return;
    try {
      const cfg = this.config.get();
      const projectId = await this.resolveProjectId();
      const { issues, nextCursor } = await this.client.listIssues({
        projectId,
        query: this.composedQuery(buildServerQuery(this.filter)),
        statsPeriod: cfg.statsPeriod,
        cursor: this.nextCursor,
      });
      const known = new Set(this.issues.map((i) => i.id));
      this.issues.push(...issues.filter((i) => !known.has(i.id)));
      this.nextCursor = nextCursor;
      this.fireChanged();
      void this.prefetchEvents(this.epoch);
    } catch (e) {
      this.handleError(e);
    }
  }

  async loadArchived(reload = false): Promise<void> {
    if (this.archivedLoaded && !reload) return;
    try {
      const cfg = this.config.get();
      const projectId = await this.resolveProjectId();
      const { status: _s, ...rest } = this.filter;
      const query = this.composedQuery(buildServerQuery({ ...rest, status: 'ignored' }));
      const { issues, nextCursor } = await this.client.listIssues({ projectId, query, statsPeriod: cfg.statsPeriod });
      this.archived = issues;
      this.archivedCursor = nextCursor;
      this.archivedLoaded = true;
      this.fireChanged();
    } catch (e) {
      this.handleError(e);
    }
  }

  async loadMoreArchived(): Promise<void> {
    if (!this.archivedCursor) return;
    try {
      const cfg = this.config.get();
      const projectId = await this.resolveProjectId();
      const { status: _s, ...rest } = this.filter;
      const { issues, nextCursor } = await this.client.listIssues({
        projectId,
        query: this.composedQuery(buildServerQuery({ ...rest, status: 'ignored' })),
        statsPeriod: cfg.statsPeriod,
        cursor: this.archivedCursor,
      });
      const known = new Set(this.archived.map((i) => i.id));
      this.archived.push(...issues.filter((i) => !known.has(i.id)));
      this.archivedCursor = nextCursor;
      this.fireChanged();
    } catch (e) {
      this.handleError(e);
    }
  }

  private async prefetchEvents(myEpoch: number): Promise<void> {
    const targets = this.issues.filter((i) => !this.events.has(i.id)).slice(0, EVENT_PREFETCH_LIMIT);
    if (targets.length === 0) return;
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length && myEpoch === this.epoch) {
        const issue = targets[cursor++];
        try {
          const event = await this.client.getLatestEvent(issue.id);
          if (myEpoch !== this.epoch) return;
          this.events.set(issue.id, event);
          this.fireChanged();
        } catch (e) {
          if (e instanceof SentryApiError && (e.status === 429 || e.status === 401 || e.status === 403)) {
            this.handleError(e);
            return;
          }
          log(`Failed to fetch latest event for ${issue.shortId}: ${e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
  }

  /** Latest event for an issue, refetching when the issue has seen new events since it was cached. */
  async getEvent(issueId: string): Promise<SentryEvent | undefined> {
    const issue = this.getIssue(issueId);
    const cached = this.events.get(issueId);
    if (cached && issue?.lastSeen && cached.dateCreated && Date.parse(issue.lastSeen) - Date.parse(cached.dateCreated) < 60_000) {
      return cached;
    }
    if (cached && !issue) return cached;
    try {
      const event = await this.client.getLatestEvent(issueId);
      this.events.set(issueId, event);
      this.fireChanged();
      return event;
    } catch (e) {
      if (cached) return cached;
      this.handleError(e);
      return undefined;
    }
  }

  /** Optimistic update with rollback; throws on API failure so callers can notify. */
  async applyUpdate(ids: string[], update: IssueUpdate): Promise<void> {
    const snapshotIssues = [...this.issues];
    const snapshotArchived = [...this.archived];
    const snapshotCount = this.openCount;

    const apply = (issue: Issue): Issue => {
      const next = { ...issue };
      if (update.status) next.status = update.status;
      if (update.assignedTo !== undefined) {
        next.assignedTo = update.assignedTo ? { name: update.assignedTo, type: update.assignedTo.split(':')[0] } : null;
      }
      return next;
    };
    const idSet = new Set(ids);
    this.issues = this.issues.map((i) => (idSet.has(i.id) ? apply(i) : i));
    this.archived = this.archived.map((i) => (idSet.has(i.id) ? apply(i) : i));

    if (update.status && update.status !== 'unresolved' && this.filter.status === 'unresolved') {
      const moved = this.issues.filter((i) => idSet.has(i.id));
      this.issues = this.issues.filter((i) => !idSet.has(i.id));
      this.openCount = Math.max(0, this.openCount - moved.length);
      if (update.status === 'ignored' && this.archivedLoaded) {
        this.archived = [...moved, ...this.archived];
      }
    }
    if (update.status === 'unresolved') {
      const restored = this.archived.filter((i) => idSet.has(i.id));
      this.archived = this.archived.filter((i) => !idSet.has(i.id));
      if (this.filter.status === 'unresolved' && restored.length) {
        this.issues = [...restored, ...this.issues];
        this.openCount += restored.length;
      }
    }
    this.fireChanged();

    try {
      await this.client.updateIssues(ids, update);
    } catch (e) {
      this.issues = snapshotIssues;
      this.archived = snapshotArchived;
      this.openCount = snapshotCount;
      this.fireChanged();
      throw e;
    }
  }

  pausePolling(): void {
    this.pollingPaused = true;
  }

  resumePolling(): void {
    this.pollingPaused = false;
    this.restartPolling();
  }

  restartPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const seconds = vscode.workspace.getConfiguration('sentry').get<number>('pollIntervalSeconds', 60);
    if (seconds <= 0) return;
    this.pollTimer = setInterval(() => {
      if (this.pollingPaused || this.loading || Date.now() < this.backoffUntil) return;
      void this.refresh();
    }, Math.max(10, seconds) * 1000);
  }

  private handleError(e: unknown): void {
    if (e instanceof SentryApiError) {
      this.lastError = e.message;
      if (e.status === 429 && e.retryAfterMs) {
        this.backoffUntil = Date.now() + Math.min(e.retryAfterMs, 15 * 60_000);
        log(`Rate limited; backing off until ${new Date(this.backoffUntil).toISOString()}`);
      }
      if (e.status === 401 || e.status === 403) {
        this.pausePolling();
      }
    } else {
      this.lastError = String(e);
    }
    log(`Store error: ${this.lastError}`);
    this.fireChanged();
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.fireHandle) clearTimeout(this.fireHandle);
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
    this._onDidChangeSelection.dispose();
  }
}
