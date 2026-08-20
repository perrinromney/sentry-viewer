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
npm run links                       # interactive picker (recommended)
npm run links:list                  # status table only, never interactive
npm run link                        # link every supported editor found here
npm run link -- --vscode            # VS Code
npm run link -- --cursor            # Cursor
npm run link -- --antigravity       # Antigravity
npm run link -- --vscodium --windsurf --vscode-insiders
npm run link -- --path /some/other/extensions   # any other location
npm run unlink                      # remove the symlinks again
```

`npm run links` opens an interactive picker: a numbered table of editors, each
colored by state (`linked`, `unlinked`, `stale`, `copy`, `other`, `absent`),
with a Notes section for anything needing attention. Choose a row, then link or
unlink it; the table is redrawn after each action so you can keep going, and `q`
quits.

```
  ╭───┬──────────────────┬────────────┬───────────────────────────────╮
  │ # │ EDITOR           │ STATUS     │ EXTENSIONS DIRECTORY          │
  ├───┼──────────────────┼────────────┼───────────────────────────────┤
  │ 1 │ VS Code          │ ● linked   │ ~/.vscode/extensions          │
  │ 2 │ Cursor           │ ▲ stale    │ ~/.cursor/extensions          │
  │ 3 │ Antigravity      │ · absent   │ ~/.antigravity/extensions     │
  ╰───┴──────────────────┴────────────┴───────────────────────────────╯

  Row to change [1-3] · (r)efresh · (q)uit ›
```

The action prompt says what will happen to that specific row (create the
directory, replace a foreign link, remove the older link, …). The two risky
cases — deleting a real installed copy, or creating a missing directory — ask
for confirmation, and a "yes" applies only to that one action, never to later
rows. `npm run links:list` (or piping/redirecting `npm run links`) prints the
plain table with no prompts, which is what scripts and CI should use.

Useful flags: `--all` (every known editor), `--detected` (only ones already
present), `--create-dir` (create a missing extensions directory, e.g. before an
editor's first run), `--force` (replace a real directory left by a packaged
install), `--no-build`, and `-n/--dry-run`. Output styling adapts to the
terminal: color is disabled when piped, when `$NO_COLOR` is set, or with
`--no-color`; box-drawing glyphs fall back to ASCII on non-UTF-8 locales or with
`--ascii`; the table narrows to fit `$COLUMNS`.

Portability: the npm scripts run `scripts/run-link.mjs`, which dispatches to a
native implementation per platform — PowerShell (`scripts/install-link.ps1`) on
Windows, and the shell version (`scripts/install-link.sh`) elsewhere. Both accept
the same `--flags`, print the same table, and understand each other's links, so
`npm run link -- --cursor` behaves identically everywhere. Override the choice
with `SENTRY_LINK_IMPL=sh|ps` (for example to use Git Bash on Windows).

- **Windows**: needs PowerShell (5.1 ships with Windows; 7+ works too) — no Git
  Bash required. Directory symlinks normally need Developer Mode or an elevated
  shell, so when symlink creation is denied the script automatically falls back
  to a **directory junction**, which needs no privileges; `--junction` forces
  that. The PowerShell switch style (`-Cursor`, `-DryRun`) is accepted alongside
  `--cursor`/`--dry-run`.
- **Linux/macOS**: bash 3.2+ (so stock macOS works), no GNU-only tools.
- Both probe the canonical `~/.<editor>/extensions` paths plus remote/WSL server
  directories (`~/.vscode-server/extensions`, …), Linux Flatpak sandboxes, and
  `$VSCODE_EXTENSIONS` (which, when set, wins outright).

Neither implementation deletes anything it did not create: links pointing
elsewhere are left alone, real directories require `--force` (or an explicit
confirmation in the picker), links from older versions are pruned so the editor
cannot load two copies, and links are removed with a non-recursive delete so the
repository behind them can never be touched.

### Sentry CLI check

After a successful link, both implementations print an advisory about
`sentry-cli` — optional tooling, but it is where the extension's one-time token
import reads from, and what uploads sourcemaps so production stack frames
resolve to real files:

```
  Sentry CLI (optional — token import and sourcemap uploads)
  ● sentry-cli 3.6.2  /usr/bin/sentry-cli
  ● auth token on file (~/.sentryclirc)
```

When the CLI is missing it lists the install commands for your platform — npm on
any OS, plus the official installer on Linux/macOS, Homebrew on macOS, or Scoop
on Windows when those are present — and offers to run one for you:

```
  ▲ not installed
  install with:
    1) npm install -g @sentry/cli
    2) curl -sL https://sentry.io/get-cli/ | sh
  Install now? [1-2, or N to skip] ›
```

The token check looks at `$SENTRY_AUTH_TOKEN` and `.sentryclirc` (project, then
home) and reports only *where* a token was found, never its value. Everything
here is advisory: it never changes the link's exit status, it only prompts on a
terminal (piped runs just print the commands), and `--no-cli-check` skips it.

To run the check on its own, without creating or removing any links:

```bash
npm run doctor                      # same as --cli-check / --doctor
```

You can also press `c` in the `npm run links` picker at any time. Unlike the
post-link advisory, the standalone check **exits with the number of problems
found** — `0` when the CLI is healthy and a token is on file, `1` if one of those
is missing, `2` if both — so it works as a scripted precondition:

```bash
npm run doctor >/dev/null 2>&1 || echo 'set up sentry-cli first'
```
