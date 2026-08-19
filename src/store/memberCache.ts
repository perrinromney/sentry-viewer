import { SentryClient } from '../sentry/client';
import { Member, Team } from '../sentry/types';

const TTL_MS = 10 * 60_000;

/** Lazy cache of org members and teams for the assign QuickPick. */
export class MemberCache {
  private members: Member[] | undefined;
  private teams: Team[] | undefined;
  private fetchedAt = 0;

  constructor(private readonly client: SentryClient) {}

  invalidate(): void {
    this.members = undefined;
    this.teams = undefined;
  }

  async get(): Promise<{ members: Member[]; teams: Team[] }> {
    if (!this.members || !this.teams || Date.now() - this.fetchedAt > TTL_MS) {
      [this.members, this.teams] = await Promise.all([this.client.listMembers(), this.client.listTeams()]);
      this.fetchedAt = Date.now();
    }
    return { members: this.members, teams: this.teams };
  }
}
