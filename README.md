# Sentry Viewer for VS Code

Browse, triage, and jump to code for Sentry issues without leaving the editor.

## Features

- **Sidebar (activity bar)** — tree of open issues with severity, event/user counts, and relative last-seen; a collapsible **Archived** section; and a **badge on the activity-bar icon** showing the unresolved count (always the true total, independent of active filters).
- **Bottom panel ("Sentry" tab)** — rich detail for the selected issue: actions, stack trace with clickable frames, tags, structured contexts (`vue.*`, `selection.*`, …), and recent breadcrumbs.
- **Jump to code** — stack frames are suffix-matched against workspace files (works in monorepos); clicking an issue or frame opens the file at the line. Minified `assets/*.js` frames are detected and marked non-linkable; when nothing resolves, the issue opens in the browser instead.
- **Triage** — resolve, resolve-in-next-release, unresolve, archive, unarchive, and assign (members/teams QuickPick), from context menus, the detail panel, or hover cards. Updates are optimistic with rollback on failure.
- **Search & filter** — raw Sentry query syntax (`company:turner error.type:TypeError`) plus a guided field picker. Tag filters run server-side; **event-context filters** (`vue.componentName`, `selection.session`, …) run client-side against each issue's latest event, with value suggestions gathered from recent events.
- **Inline context** — CodeLens above offending lines, severity-colored gutter/line decorations, hover cards with actions, and a status-bar count for the active file (click to filter the sidebar to that file). Each layer can be toggled (`sentry.inline.*`).

## Setup

1. Open the Sentry sidebar icon and **Sign In**. If `~/.sentryclirc` (sentry-cli) has a token, you'll be offered a one-time import; tokens are kept in VS Code SecretStorage.
2. Configure org/project via the **gear icon** (settings window), VS Code settings, or a workspace config (below).

## Workspace config: `.sentry_viewer/`

Pin a repository to a specific Sentry org/project by committing `.sentry_viewer/config.json` at a workspace folder root (`Sentry: Create .sentry_viewer Workspace Config` scaffolds it):

```json
{
  "organization": "my-org",
  "project": "my-project",
  "statsPeriod": "90d",
  "defaultQuery": "",
  "pathMappings": { "src/": "app/src/" }
}
```

Personal overrides (different token or base URL) go in `.sentry_viewer/local.json` — auto-gitignored via `.sentry_viewer/.gitignore`:

```json
{ "token": "sntrys_…", "baseUrl": "https://sentry.example.com" }
```

Precedence per field: `local.json` → `config.json` → VS Code settings → `~/.sentryclirc`. The settings window shows where each effective value comes from. A repo-committed `baseUrl` that differs from your own configuration requires one-time confirmation before it is used.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `sentry.baseUrl` | `https://sentry.io` | Server URL (self-hosted Sentry) |
| `sentry.organization` / `sentry.project` | – | Slugs (overridable per-repo) |
| `sentry.statsPeriod` | `90d` | Issue time window |
| `sentry.pollIntervalSeconds` | `60` | Badge/list refresh (0 = off) |
| `sentry.openCodeOnSelect` | `true` | Jump to code when selecting an issue |
| `sentry.inline.codeLens` / `.decorations` / `.hovers` / `.statusBar` | `true` | Inline layers |
| `sentry.pathMappings` | `{}` | Frame-prefix → workspace-prefix overrides |

## Notes

- Inline markers use the line numbers from the event's deployed build; treat them as approximate if the file has changed since.
- Uploading sourcemaps to Sentry (release + `sentry-cli sourcemaps upload` in CI) makes production frames resolvable and dramatically improves jump-to-code.

## Development

```bash
npm install
npm run watch     # esbuild watch
# F5 in VS Code → "Run Extension" (or the variant that opens the allucent repo)
npm test          # vitest on the pure modules (resolver, query, config merge)
npm run package   # typecheck + build + .vsix
```
