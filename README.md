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

### Install locally via symlink

`scripts/install-link.sh` builds the extension and symlinks this repo into your
editor's extensions directory, so `Developer: Reload Window` picks up each
rebuild without repackaging. Pair it with `npm run watch` for a fast loop.

```bash
npm run link                        # every supported editor found on this machine
npm run link -- --vscode            # VS Code
npm run link -- --cursor            # Cursor
npm run link -- --antigravity       # Antigravity
npm run link -- --vscodium --windsurf --vscode-insiders
npm run link -- --path /some/other/extensions   # any other location
npm run links                       # show link status everywhere
npm run unlink                      # remove the symlinks again
```

`npm run links` prints a status table — one row per editor with its extensions
directory, colored by state (`linked`, `unlinked`, `stale`, `copy`, `other`,
`absent`), plus a Notes section for anything that needs attention:

```
  ╭──────────────────┬────────────┬───────────────────────────────╮
  │ EDITOR           │ STATUS     │ EXTENSIONS DIRECTORY          │
  ├──────────────────┼────────────┼───────────────────────────────┤
  │ VS Code          │ ● linked   │ ~/.vscode/extensions          │
  │ Cursor           │ ▲ stale    │ ~/.cursor/extensions          │
  │ Antigravity      │ · absent   │ ~/.antigravity/extensions     │
  ╰──────────────────┴────────────┴───────────────────────────────╯
```

Useful flags: `--all` (every known editor), `--detected` (only ones already
present), `--create-dir` (create a missing extensions directory, e.g. before an
editor's first run), `--force` (replace a real directory left by a packaged
install), `--no-build`, and `-n/--dry-run`. Output styling adapts to the
terminal: color is disabled when piped, when `$NO_COLOR` is set, or with
`--no-color`; box-drawing glyphs fall back to ASCII on non-UTF-8 locales or with
`--ascii`; the table narrows to fit `$COLUMNS`.

Portability: works on Linux, macOS (including stock bash 3.2), and Windows
git-bash; it probes the canonical `~/.<editor>/extensions` paths plus
remote/WSL server directories (`~/.vscode-server/extensions`, …), Linux Flatpak
sandboxes, and `$VSCODE_EXTENSIONS` (which, when set, wins outright). It never
deletes anything it did not create: symlinks pointing elsewhere are left alone,
real directories require `--force`, and links from older versions of this
extension are pruned so the editor cannot load two copies.
