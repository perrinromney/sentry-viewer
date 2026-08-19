import {
  Issue,
  IssueTagKey,
  IssueUpdate,
  Member,
  Organization,
  Project,
  SentryApiError,
  SentryEvent,
  Team,
} from './types';

export interface ClientOptions {
  getBaseUrl: () => string;
  getOrg: () => string;
  getToken: () => Promise<string | undefined>;
  onAuthFail?: () => void;
  log?: (message: string) => void;
}

export interface ListIssuesOptions {
  projectId?: string;
  query: string;
  statsPeriod: string;
  sort?: 'date' | 'freq' | 'new' | 'user';
  cursor?: string;
  limit?: number;
}

/** Parse a Sentry `Link` header, returning the next cursor only when more results exist. */
export function parseNextCursor(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    if (part.includes('rel="next"') && part.includes('results="true"')) {
      const m = part.match(/cursor="([^"]+)"/);
      if (m) return m[1];
    }
  }
  return undefined;
}

export class SentryClient {
  constructor(private readonly opts: ClientOptions) {}

  private async request<T>(path: string, init?: RequestInit): Promise<{ data: T; headers: Headers }> {
    const token = await this.opts.getToken();
    if (!token) {
      this.opts.onAuthFail?.();
      throw new SentryApiError('Not signed in to Sentry', 401);
    }
    const base = this.opts.getBaseUrl().replace(/\/$/, '');
    const url = path.startsWith('http') ? path : `${base}/api/0${path}`;
    this.opts.log?.(`${init?.method ?? 'GET'} ${url}`);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      throw new SentryApiError(`Network error reaching Sentry: ${e instanceof Error ? e.message : e}`, 0);
    }
    if (res.status === 401 || res.status === 403) {
      this.opts.onAuthFail?.();
      throw new SentryApiError(`Sentry authentication failed (${res.status})`, res.status);
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '60');
      throw new SentryApiError('Sentry rate limit hit', 429, Math.max(1, retryAfter) * 1000);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { detail?: string };
        detail = body?.detail ?? '';
      } catch {
        /* non-JSON error body */
      }
      throw new SentryApiError(detail || `Sentry API error ${res.status} for ${path}`, res.status);
    }
    const remaining = res.headers.get('X-Sentry-Rate-Limit-Remaining');
    if (remaining !== null && Number(remaining) < 10) {
      this.opts.log?.(`Rate limit nearly exhausted: ${remaining} requests remaining`);
    }
    if (res.status === 204) return { data: undefined as T, headers: res.headers };
    return { data: (await res.json()) as T, headers: res.headers };
  }

  private org(): string {
    const org = this.opts.getOrg();
    if (!org) throw new SentryApiError('No Sentry organization configured', 400);
    return encodeURIComponent(org);
  }

  async listIssues(o: ListIssuesOptions): Promise<{ issues: Issue[]; nextCursor?: string }> {
    const params = new URLSearchParams();
    if (o.projectId) params.set('project', o.projectId);
    params.set('statsPeriod', o.statsPeriod);
    if (o.query) params.set('query', o.query);
    params.set('sort', o.sort ?? 'date');
    params.set('limit', String(o.limit ?? 100));
    if (o.cursor) params.set('cursor', o.cursor);
    const { data, headers } = await this.request<Issue[]>(`/organizations/${this.org()}/issues/?${params}`);
    return { issues: data, nextCursor: parseNextCursor(headers.get('link')) };
  }

  async getLatestEvent(issueId: string): Promise<SentryEvent> {
    const { data } = await this.request<SentryEvent>(`/issues/${issueId}/events/latest/`);
    return data;
  }

  async updateIssues(ids: string[], update: IssueUpdate): Promise<void> {
    const params = ids.map((id) => `id=${encodeURIComponent(id)}`).join('&');
    await this.request<unknown>(`/organizations/${this.org()}/issues/?${params}`, {
      method: 'PUT',
      body: JSON.stringify(update),
    });
  }

  async listOrganizations(): Promise<Organization[]> {
    const { data } = await this.request<Organization[]>(`/organizations/`);
    return data;
  }

  async listProjects(): Promise<Project[]> {
    const { data } = await this.request<Project[]>(`/organizations/${this.org()}/projects/`);
    return data;
  }

  async listMembers(): Promise<Member[]> {
    const { data } = await this.request<Member[]>(`/organizations/${this.org()}/members/`);
    return data;
  }

  async listTeams(): Promise<Team[]> {
    const { data } = await this.request<Team[]>(`/organizations/${this.org()}/teams/`);
    return data;
  }

  async getIssueTags(issueId: string): Promise<IssueTagKey[]> {
    const { data } = await this.request<IssueTagKey[]>(`/issues/${issueId}/tags/`);
    return data;
  }
}
