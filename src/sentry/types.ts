export interface SentryUserRef {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  username?: string | null;
  type?: string;
}

export interface Issue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  level: string;
  status: 'unresolved' | 'resolved' | 'ignored';
  substatus?: string | null;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  assignedTo?: SentryUserRef | null;
  metadata: { type?: string; value?: string; title?: string };
  project: { id: string; slug: string };
}

export interface Frame {
  filename?: string | null;
  absPath?: string | null;
  function?: string | null;
  lineNo?: number | null;
  colNo?: number | null;
  inApp?: boolean;
}

export interface Breadcrumb {
  category?: string;
  message?: string | null;
  level?: string;
  timestamp?: string;
  type?: string;
  data?: Record<string, unknown>;
}

export interface ExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: { frames?: Frame[] } | null;
}

export type EventEntry =
  | { type: 'exception'; data: { values?: ExceptionValue[] } }
  | { type: 'breadcrumbs'; data: { values?: Breadcrumb[] } }
  | { type: string; data: Record<string, unknown> };

export interface SentryEvent {
  id: string;
  eventID: string;
  title?: string;
  tags?: { key: string; value: string }[];
  contexts?: Record<string, Record<string, unknown> | undefined>;
  context?: Record<string, unknown>;
  user?: (SentryUserRef & { ip_address?: string }) | null;
  entries?: EventEntry[];
  dateCreated?: string;
}

export interface Member {
  id: string;
  email: string;
  name?: string;
  user?: { id: string; name?: string; email?: string } | null;
}

export interface Team {
  id: string;
  slug: string;
  name?: string;
}

export interface Project {
  id: string;
  slug: string;
  name?: string;
  platform?: string | null;
}

export interface Organization {
  id: string;
  slug: string;
  name?: string;
}

export interface IssueTagKey {
  key: string;
  name?: string;
  topValues?: { value: string; count?: number }[];
}

export interface IssueUpdate {
  status?: 'resolved' | 'unresolved' | 'ignored';
  statusDetails?: { inNextRelease?: boolean };
  substatus?: string;
  assignedTo?: string;
}

export class SentryApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SentryApiError';
  }
}
