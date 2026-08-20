#!/usr/bin/env bash
#
# Symlink this extension into local editor extension directories, so that
# "Developer: Reload Window" picks up each rebuild without repackaging.
#
# With no arguments (or --list) on a terminal this is an interactive picker:
# a numbered table of editors, choose a row, then link or unlink it.
#
# Portability notes:
#   * Works with bash 3.2 (stock macOS) upwards - no associative arrays,
#     no GNU-only flags such as `readlink -f`.
#   * VS Code and its forks keep extensions under the user's home directory on
#     every platform (only user-data lives in ~/Library or %APPDATA%), so the
#     same relative paths apply on Linux, macOS, and Windows (git-bash/MSYS).
#   * Also probes remote/WSL server directories (.vscode-server, ...) and Linux
#     Flatpak sandboxes, and honours $VSCODE_EXTENSIONS.
#   * Anything unusual: pass --path DIR.
#
# Run `scripts/install-link.sh --help` for usage.

set -euo pipefail

# ---------- portable helpers ----------

# Physical path of $1, resolving symlinks, without readlink -f (BSD/macOS lack it).
resolve_path() {
  local p="$1" dir base
  if [ -d "$p" ]; then
    ( cd "$p" 2>/dev/null && pwd -P ) || printf '%s\n' "$p"
  else
    dir="$(dirname -- "$p")"
    base="$(basename -- "$p")"
    if [ -d "$dir" ]; then
      printf '%s/%s\n' "$( cd "$dir" && pwd -P )" "$base"
    else
      printf '%s\n' "$p"
    fi
  fi
}

# Raw symlink target, for display only.
link_target() {
  readlink -- "$1" 2>/dev/null || printf '?\n'
}

expand_tilde() {
  case "$1" in
    "~")   printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${1#\~/}" ;;
    *)     printf '%s\n' "$1" ;;
  esac
}

SCRIPT_DIR="$( cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P )"
REPO_DIR="$( cd -- "$SCRIPT_DIR/.." && pwd -P )"

# ---------- presentation (color / box drawing / layout) ----------

COLOR_MODE="auto"   # auto | always | never
GLYPH_MODE="auto"   # auto | unicode | ascii

C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""; C_CYAN=""

use_color() {
  case "$COLOR_MODE" in
    never)  return 1 ;;
    always) return 0 ;;
  esac
  [ -n "${NO_COLOR:-}" ] && return 1          # https://no-color.org
  [ "${TERM:-dumb}" = "dumb" ] && return 1
  [ -t 1 ] || return 1
  return 0
}

use_unicode() {
  case "$GLYPH_MODE" in
    ascii)   return 1 ;;
    unicode) return 0 ;;
  esac
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *UTF-8*|*utf8*|*UTF8*|*utf-8*) return 0 ;;
  esac
  return 1
}

init_style() {
  if use_color; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
    C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
  fi
  if use_unicode; then
    BX_TL="╭"; BX_TR="╮"; BX_BL="╰"; BX_BR="╯"; BX_H="─"; BX_V="│"
    BX_T="┬"; BX_B="┴"; BX_X="┼"; BX_L="├"; BX_R="┤"
    G_OK="●"; G_WARN="▲"; G_OFF="○"; G_NONE="·"
    G_ARROW="→"; G_ELLIPSIS="…"; G_SEP="·"; G_PROMPT="›"
  else
    BX_TL="+"; BX_TR="+"; BX_BL="+"; BX_BR="+"; BX_H="-"; BX_V="|"
    BX_T="+"; BX_B="+"; BX_X="+"; BX_L="+"; BX_R="+"
    G_OK="*"; G_WARN="!"; G_OFF="o"; G_NONE="."
    G_ARROW="->"; G_ELLIPSIS="..."; G_SEP="|"; G_PROMPT=">"
  fi
}

term_width() {
  local w=""
  if [ -n "${COLUMNS:-}" ]; then
    w="$COLUMNS"
  elif command -v tput >/dev/null 2>&1; then
    w="$(tput cols 2>/dev/null || true)"
  fi
  case "$w" in
    ''|*[!0-9]*) w=100 ;;
  esac
  [ "$w" -lt 60 ] && w=60
  printf '%s\n' "$w"
}

repeat_char() {
  local n="$1" ch="$2" out=""
  while [ "$n" -gt 0 ]; do out="$out$ch"; n=$((n - 1)); done
  printf '%s' "$out"
}

# Pad $1 to width $2 (content passed as an argument, never as a format).
pad() { printf "%-${2}s" "$1"; }

truncate_str() {
  local s="$1" max="$2"
  if [ "${#s}" -le "$max" ]; then
    printf '%s' "$s"
  else
    printf '%s%s' "${s:0:$((max - 1))}" "$G_ELLIPSIS"
  fi
}

abbrev_home() {
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *)         printf '%s' "$1" ;;
  esac
}

# Wrap $1 in color $2, emitting no escape codes when color is disabled.
tint() {
  if [ -n "$2" ]; then printf '%s%s%s' "$2" "$1" "$C_RESET"; else printf '%s' "$1"; fi
}

say()  { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }

# ---------- extension identity (from package.json) ----------

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to read package.json" >&2
  exit 1
fi
PKG_META="$(
  node -e 'var p=require(process.argv[1]);
    if(!p.publisher||!p.name||!p.version){console.error("package.json needs publisher, name and version");process.exit(1)}
    process.stdout.write(p.publisher+" "+p.name+" "+p.version+"\n")' "$REPO_DIR/package.json"
)" || { echo "error: could not read publisher/name/version from package.json" >&2; exit 1; }
# `read` reports failure at EOF even when it assigned, so ignore its status.
read -r PUBLISHER NAME VERSION <<EOF || true
$PKG_META
EOF
if [ -z "${PUBLISHER:-}" ] || [ -z "${NAME:-}" ] || [ -z "${VERSION:-}" ]; then
  echo "error: could not parse extension identity from package.json" >&2
  exit 1
fi
LINK_NAME="$PUBLISHER.$NAME-$VERSION"
ID_GLOB="$PUBLISHER.$NAME-*"

# ---------- editor discovery ----------

home_roots() {
  printf '%s\n' "$HOME"
  if [ -n "${USERPROFILE:-}" ]; then
    local up="$USERPROFILE"
    if command -v cygpath >/dev/null 2>&1; then
      up="$(cygpath -u "$USERPROFILE" 2>/dev/null || printf '%s' "$USERPROFILE")"
    else
      # C:\Users\me -> /c/Users/me
      case "$up" in
        [A-Za-z]:\\*|[A-Za-z]:/*)
          up="/$(printf '%s' "${up%%:*}" | tr 'A-Z' 'a-z')/$(printf '%s' "${up#*:}" | tr '\\' '/')"
          up="$(printf '%s' "$up" | sed 's://*:/:g')"
          ;;
      esac
    fi
    [ "$up" != "$HOME" ] && printf '%s\n' "$up"
  fi
  return 0
}

relative_dirs_for() {
  case "$1" in
    vscode)
      printf '%s\n' \
        ".vscode/extensions" \
        ".vscode-server/extensions" \
        ".var/app/com.visualstudio.code/data/vscode/extensions"
      ;;
    vscode-insiders)
      printf '%s\n' \
        ".vscode-insiders/extensions" \
        ".vscode-server-insiders/extensions" \
        ".var/app/com.visualstudio.code.insiders/data/vscode-insiders/extensions"
      ;;
    vscodium)
      printf '%s\n' \
        ".vscode-oss/extensions" \
        ".vscodium/extensions" \
        ".vscodium-server/extensions" \
        ".var/app/com.vscodium.codium/data/codium/extensions"
      ;;
    cursor)
      printf '%s\n' \
        ".cursor/extensions" \
        ".cursor-server/extensions"
      ;;
    antigravity)
      printf '%s\n' \
        ".antigravity/extensions" \
        ".antigravity-server/extensions" \
        ".antigravity-insiders/extensions"
      ;;
    windsurf)
      printf '%s\n' \
        ".windsurf/extensions" \
        ".windsurf-server/extensions"
      ;;
  esac
}

ALL_EDITORS="vscode vscode-insiders vscodium cursor antigravity windsurf"

label_for() {
  case "$1" in
    vscode)          echo "VS Code" ;;
    vscode-insiders) echo "VS Code Insiders" ;;
    vscodium)        echo "VSCodium" ;;
    cursor)          echo "Cursor" ;;
    antigravity)     echo "Antigravity" ;;
    windsurf)        echo "Windsurf" ;;
    *)               echo "$1" ;;
  esac
}

cli_for() {
  case "$1" in
    vscode)          echo "code" ;;
    vscode-insiders) echo "code-insiders" ;;
    vscodium)        echo "codium" ;;
    cursor)          echo "cursor" ;;
    antigravity)     echo "antigravity" ;;
    windsurf)        echo "windsurf" ;;
    *)               echo "" ;;
  esac
}

candidates_for() {
  local editor="$1" root rel
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      printf '%s\n' "$root/$rel"
    done < <(relative_dirs_for "$editor")
  done < <(home_roots)
}

# Echo the first existing candidate (exit 0), else the canonical one (exit 1).
resolve_dir() {
  local first="" dir
  # An explicit environment override wins outright, even if not yet created.
  if [ "$1" = "vscode" ] && [ -n "${VSCODE_EXTENSIONS:-}" ]; then
    printf '%s\n' "${VSCODE_EXTENSIONS%/}"
    [ -d "${VSCODE_EXTENSIONS%/}" ] && return 0
    return 1
  fi
  while IFS= read -r dir; do
    [ -n "$first" ] || first="$dir"
    if [ -d "$dir" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done < <(candidates_for "$1")
  printf '%s\n' "$first"
  return 1
}

# ---------- options ----------

TARGET_EDITORS=""
CUSTOM_PATHS=""
ACTION=""            # ""(=menu) | install | uninstall | list
DO_BUILD=1
CREATE_DIR=0
FORCE=0
DRY_RUN=0
DETECTED_ONLY=0
INTERACTIVE="auto"   # auto | never
CLI_CHECK=1          # sentry-cli health/token advisory after linking

usage() {
  cat <<EOF
Link $PUBLISHER.$NAME v$VERSION into local editor extension directories.

USAGE
  scripts/install-link.sh [targets] [options]
  npm run links                       # interactive picker (this is the default)
  npm run link -- [targets]           # non-interactive install

With no target flags on a terminal, an interactive numbered table is shown:
pick a row, then link or unlink that editor. Piped or redirected output falls
back to a plain table.

TARGETS (repeatable)
  --vscode                 ~/.vscode/extensions
  --vscode-insiders        ~/.vscode-insiders/extensions
  --vscodium               ~/.vscode-oss/extensions
  --cursor                 ~/.cursor/extensions
  --antigravity            ~/.antigravity/extensions
  --windsurf               ~/.windsurf/extensions
  --all                    every known editor above
  --detected               every known editor whose directory already exists
  --path DIR               a specific extensions directory

  Remote/WSL server dirs (.vscode-server/extensions, .cursor-server/...) and
  Linux Flatpak sandboxes are probed automatically, as is \$VSCODE_EXTENSIONS.

ACTIONS
  --install                link the given targets (implied by any target flag)
  --uninstall              remove this extension's symlink(s)
  --list                   status table; interactive when run on a terminal
  --plain                  status table only, never interactive

OPTIONS
  --no-build               skip 'npm run build' (dist/ must already exist)
  --create-dir             create the extensions directory if it is missing
  --force                  replace a real (non-symlink) directory at the target
  -n, --dry-run            print planned actions without changing anything
  --color WHEN             auto (default), always, or never
  --no-color               same as --color never (also honours \$NO_COLOR)
  --ascii                  plain ASCII table instead of box-drawing glyphs
  --no-cli-check           skip the sentry-cli health/token advisory after linking
  -h, --help               this help

CHECKS
  --cli-check, --doctor    report sentry-cli health and whether a token is on
                           file, without touching any links. Exits non-zero when
                           the CLI is missing/broken or no token was found, so it
                           is usable as a scripted precondition.

EXAMPLES
  npm run links                     # interactive picker
  npm run link -- --cursor          # link Cursor, no prompts
  npm run link -- --all --create-dir
  npm run link -- --path ~/.config/SomeFork/extensions
  npm run unlink                    # remove links everywhere
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --vscode|--vscode-insiders|--vscodium|--cursor|--antigravity|--windsurf)
      TARGET_EDITORS="$TARGET_EDITORS ${1#--}"
      [ -n "$ACTION" ] || ACTION="install" ;;
    --all)
      TARGET_EDITORS="$TARGET_EDITORS $ALL_EDITORS"
      [ -n "$ACTION" ] || ACTION="install" ;;
    --detected)
      DETECTED_ONLY=1
      [ -n "$ACTION" ] || ACTION="install" ;;
    --path)
      [ $# -ge 2 ] || { echo "error: --path needs a directory" >&2; exit 1; }
      CUSTOM_PATHS="$CUSTOM_PATHS
$(expand_tilde "$2")"
      [ -n "$ACTION" ] || ACTION="install"
      shift ;;
    --path=*)
      CUSTOM_PATHS="$CUSTOM_PATHS
$(expand_tilde "${1#--path=}")"
      [ -n "$ACTION" ] || ACTION="install" ;;
    --install)                     ACTION="install" ;;
    --uninstall|--remove|--unlink) ACTION="uninstall" ;;
    --list|--status)               ACTION="list" ;;
    --plain|--no-interactive)      ACTION="list"; INTERACTIVE="never" ;;
    --no-build)    DO_BUILD=0 ;;
    --create-dir)  CREATE_DIR=1 ;;
    --force)       FORCE=1 ;;
    -n|--dry-run)  DRY_RUN=1 ;;
    --color)
      [ $# -ge 2 ] || { echo "error: --color needs auto|always|never" >&2; exit 1; }
      COLOR_MODE="$2"; shift ;;
    --color=*)     COLOR_MODE="${1#--color=}" ;;
    --no-color)    COLOR_MODE="never" ;;
    --ascii)       GLYPH_MODE="ascii" ;;
    --no-cli-check|--skip-cli-check) CLI_CHECK=0 ;;
    --cli-check|--check-cli|--doctor) ACTION="clicheck" ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "error: unknown option '$1' (try --help)" >&2; exit 1 ;;
  esac
  shift
done

[ -n "$ACTION" ] || ACTION="list"

init_style

# Interactive only for the table view, on a real terminal, with a readable tty.
TTY_IN=""
if [ -r /dev/tty ]; then TTY_IN="/dev/tty"; elif [ -t 0 ]; then TTY_IN="/dev/stdin"; fi
if [ "$ACTION" = "list" ] && [ "$INTERACTIVE" = "auto" ] && [ -t 1 ] && [ -n "$TTY_IN" ]; then
  ACTION="menu"
fi

prompt_read() { # $1 = prompt; sets ANSWER ("q" on EOF)
  printf '%s' "$1"
  if ! IFS= read -r ANSWER < "$TTY_IN"; then
    ANSWER="q"
    printf '\n'
  fi
}

# ---------- scanning ----------

# Emit "state<TAB>basename<TAB>detail" for each entry matching our extension id.
scan_dir() {
  local dir="$1" entry base resolved
  [ -d "$dir" ] || return 0
  for entry in "$dir"/$ID_GLOB; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    base="$(basename -- "$entry")"
    if [ -L "$entry" ]; then
      if [ ! -e "$entry" ]; then
        printf 'broken\t%s\t%s\n' "$base" "$(link_target "$entry")"
        continue
      fi
      resolved="$(resolve_path "$entry")"
      if [ "$resolved" = "$REPO_DIR" ]; then
        if [ "$base" = "$LINK_NAME" ]; then
          printf 'linked\t%s\tthis repo\n' "$base"
        else
          printf 'stale\t%s\tthis repo (older version)\n' "$base"
        fi
      else
        printf 'other\t%s\t%s\n' "$base" "$resolved"
      fi
    else
      printf 'copy\t%s\treal directory, not a link\n' "$base"
    fi
  done
  return 0
}

# Aggregate status word for a directory: linked | stale | copy | other | unlinked
dir_status() {
  local dir="$1" status="unlinked" state _base _detail
  while IFS="	" read -r state _base _detail; do
    [ -n "$state" ] || continue
    case "$state" in
      linked) status="linked" ;;
      stale)  [ "$status" = "linked" ] || status="stale" ;;
      copy)   [ "$status" = "linked" ] || status="copy" ;;
      other|broken) [ "$status" = "linked" ] || status="other" ;;
    esac
  done <<EOF
$(scan_dir "$dir")
EOF
  printf '%s\n' "$status"
}

# ROWS lines: "label<TAB>status<TAB>dir<TAB>cli"; NOTES lines: "label<TAB>state<TAB>base<TAB>detail"
ROWS=""
NOTES=""
N_LINKED=0; N_UNLINKED=0; N_ABSENT=0; N_ATTENTION=0

collect_rows() {
  ROWS=""; NOTES=""
  N_LINKED=0; N_UNLINKED=0; N_ABSENT=0; N_ATTENTION=0
  local editor label dir status state base detail p
  for editor in $ALL_EDITORS; do
    label="$(label_for "$editor")"
    if dir="$(resolve_dir "$editor")"; then
      status="$(dir_status "$dir")"
      while IFS="	" read -r state base detail; do
        [ -n "$state" ] || continue
        [ "$state" = "linked" ] && continue
        NOTES="$NOTES
$label	$state	$base	$detail"
      done <<EOF
$(scan_dir "$dir")
EOF
    else
      status="absent"
    fi
    case "$status" in
      linked)   N_LINKED=$((N_LINKED + 1)) ;;
      unlinked) N_UNLINKED=$((N_UNLINKED + 1)) ;;
      absent)   N_ABSENT=$((N_ABSENT + 1)) ;;
      *)        N_ATTENTION=$((N_ATTENTION + 1)) ;;
    esac
    ROWS="$ROWS
$label	$status	$dir	$(cli_for "$editor")"
  done

  # Any --path targets appear as extra rows.
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -d "$p" ]; then
      status="$(dir_status "$p")"
    else
      status="absent"
    fi
    case "$status" in
      linked)   N_LINKED=$((N_LINKED + 1)) ;;
      unlinked) N_UNLINKED=$((N_UNLINKED + 1)) ;;
      absent)   N_ABSENT=$((N_ABSENT + 1)) ;;
      *)        N_ATTENTION=$((N_ATTENTION + 1)) ;;
    esac
    ROWS="$ROWS
Custom path	$status	$p	"
  done <<EOF
$CUSTOM_PATHS
EOF
  return 0
}

row_field() { # $1 = row number (1-based), $2 = field index (1-4)
  printf '%s\n' "$ROWS" | sed -n "/./p" | sed -n "${1}p" | cut -f "$2"
}

row_count() {
  printf '%s\n' "$ROWS" | sed -n "/./p" | wc -l | tr -d ' '
}

# ---------- table rendering ----------

status_style() { # $1 = status; sets S_GLYPH, S_COLOR, S_PATH_COLOR
  case "$1" in
    linked)   S_GLYPH="$G_OK";   S_COLOR="$C_GREEN";  S_PATH_COLOR="" ;;
    unlinked) S_GLYPH="$G_OFF";  S_COLOR="$C_DIM";    S_PATH_COLOR="" ;;
    absent)   S_GLYPH="$G_NONE"; S_COLOR="$C_DIM";    S_PATH_COLOR="$C_DIM" ;;
    *)        S_GLYPH="$G_WARN"; S_COLOR="$C_YELLOW"; S_PATH_COLOR="" ;;
  esac
}

render_table() { # $1 = 1 to number the rows
  local numbered="${1:-0}" width col1=6 col2=8 col3=9 col0=1 max_col3 n=0
  local label status dir _cli shown

  width="$(term_width)"
  while IFS="	" read -r label status dir _cli; do
    [ -n "$label" ] || continue
    n=$((n + 1))
    shown="$(abbrev_home "$dir")"
    [ "${#label}" -gt "$col1" ] && col1="${#label}"
    [ "${#shown}" -gt "$col3" ] && col3="${#shown}"
  done <<EOF
$ROWS
EOF
  [ "${#n}" -gt "$col0" ] && col0="${#n}"

  max_col3=$((width - col1 - col2 - 12))
  [ "$numbered" = "1" ] && max_col3=$((max_col3 - col0 - 3))
  [ "$max_col3" -lt 20 ] && max_col3=20
  [ "$col3" -gt "$max_col3" ] && col3="$max_col3"

  rule() { # $1 left, $2 junction, $3 right
    local line=""
    [ "$numbered" = "1" ] && line="$line$(repeat_char $((col0 + 2)) "$BX_H")$2"
    say "  $1$line$(repeat_char $((col1 + 2)) "$BX_H")$2$(repeat_char $((col2 + 4)) "$BX_H")$2$(repeat_char $((col3 + 2)) "$BX_H")$3"
  }

  local head=""
  [ "$numbered" = "1" ] && head="$BX_V $(tint "$(pad '#' "$col0")" "$C_DIM") "
  rule "$BX_TL" "$BX_T" "$BX_TR"
  say "  $head$BX_V $(tint "$(pad EDITOR "$col1")" "$C_DIM") $BX_V $(tint "$(pad STATUS $((col2 + 2)))" "$C_DIM") $BX_V $(tint "$(pad 'EXTENSIONS DIRECTORY' "$col3")" "$C_DIM") $BX_V"
  rule "$BX_L" "$BX_X" "$BX_R"

  n=0
  while IFS="	" read -r label status dir _cli; do
    [ -n "$label" ] || continue
    n=$((n + 1))
    status_style "$status"
    local num=""
    [ "$numbered" = "1" ] && num="$BX_V $(tint "$(pad "$n" "$col0")" "$C_CYAN") "
    say "  $num$BX_V $(pad "$label" "$col1") $BX_V $(tint "$S_GLYPH $(pad "$status" "$col2")" "$S_COLOR") $BX_V $(tint "$(pad "$(truncate_str "$(abbrev_home "$dir")" "$col3")" "$col3")" "$S_PATH_COLOR") $BX_V"
  done <<EOF
$ROWS
EOF
  rule "$BX_BL" "$BX_B" "$BX_BR"
}

render_notes() {
  [ -n "$(printf '%s' "$NOTES" | tr -d '[:space:]')" ] || return 0
  local label state base detail color word
  say ""
  say "  $(tint Notes "$C_BOLD")"
  while IFS="	" read -r label state base detail; do
    [ -n "$label" ] || continue
    case "$state" in
      stale)  color="$C_YELLOW"; word="stale link" ;;
      broken) color="$C_RED";    word="broken link" ;;
      other)  color="$C_YELLOW"; word="foreign link" ;;
      copy)   color="$C_YELLOW"; word="installed copy" ;;
      *)      color="";          word="$state" ;;
    esac
    say "    $(tint "$(pad "$word" 15)" "$color")$(pad "$label" 20)$(tint "$base $G_ARROW $detail" "$C_DIM")"
  done <<EOF
$NOTES
EOF
}

render_summary() {
  local summary sep
  summary="$(tint "$N_LINKED linked" "$C_GREEN")"
  sep=" $(tint "$G_SEP" "$C_DIM") "
  [ "$N_ATTENTION" -gt 0 ] && summary="$summary$sep$(tint "$N_ATTENTION need attention" "$C_YELLOW")"
  [ "$N_UNLINKED" -gt 0 ] && summary="$summary$sep$N_UNLINKED unlinked"
  [ "$N_ABSENT" -gt 0 ] && summary="$summary$sep$(tint "$N_ABSENT not installed" "$C_DIM")"
  say "  $summary"
}

render_header() {
  say ""
  say "  $(tint "$PUBLISHER.$NAME" "$C_BOLD") $(tint "v$VERSION" "$C_DIM")"
  say "  $(tint "$(abbrev_home "$REPO_DIR")" "$C_DIM")"
  say ""
}

# ---------- build ----------

BUILT=0

ensure_build() {
  [ "$DO_BUILD" -eq 1 ] || {
    [ -f "$REPO_DIR/dist/extension.js" ] || step "$(tint warning "$C_YELLOW"): dist/extension.js is missing; the editor cannot activate this extension."
    return 0
  }
  [ "$BUILT" -eq 0 ] || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    step "would run: npm run build  (in $REPO_DIR)"
    BUILT=1
    return 0
  fi
  step "building..."
  if ( cd "$REPO_DIR" && npm run build >/dev/null 2>&1 ); then
    BUILT=1
    step "dist/ built"
    return 0
  fi
  step "$(tint error "$C_RED"): build failed - run 'npm run build' to see why"
  return 1
}

# ---------- link / unlink ----------

do_rm()   { if [ "$DRY_RUN" -eq 1 ]; then step "would remove: $1"; else rm -f -- "$1"; fi; }
do_rmrf() { if [ "$DRY_RUN" -eq 1 ]; then step "would remove tree: $1"; else rm -rf -- "$1"; fi; }
do_mkdir(){ if [ "$DRY_RUN" -eq 1 ]; then step "would create: $1"; else mkdir -p -- "$1"; fi; }

do_link() {
  local link="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    step "would link: $link $G_ARROW $REPO_DIR"
    return 0
  fi
  if ln -s -- "$REPO_DIR" "$link" 2>/dev/null; then
    # MSYS/git-bash silently *copies* unless MSYS=winsymlinks:nativestrict,
    # which would freeze a stale snapshot instead of tracking the repo.
    if [ ! -L "$link" ]; then
      step "$(tint error "$C_RED"): '$link' was created as a copy, not a symlink."
      step "       Your shell does not support symlinks here. Either:"
      step "         export MSYS=winsymlinks:nativestrict   (git-bash, then retry)"
      step "       or create a junction from an elevated cmd.exe:"
      step "         mklink /J \"$link\" \"$REPO_DIR\""
      do_rmrf "$link"
      return 1
    fi
    step "$(tint "$G_OK linked" "$C_GREEN") $LINK_NAME $G_ARROW $(tint "$(abbrev_home "$REPO_DIR")" "$C_DIM")"
    return 0
  fi
  step "$(tint error "$C_RED"): could not create symlink at $link"
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*)
      step "       On Windows, symlinks need Developer Mode or an elevated shell."
      step "       Alternative (cmd.exe as admin):  mklink /J \"$link\" \"$REPO_DIR\""
      ;;
    *)
      step "       Check write permission on $(dirname -- "$link")."
      ;;
  esac
  return 1
}

# Remove this extension's links (any version) that point at this repo, plus
# broken links for the same id. Never touches real directories.
prune_our_links() {
  local dir="$1" keep="${2:-}" entry base found=0
  for entry in "$dir"/$ID_GLOB; do
    [ -L "$entry" ] || continue
    [ -n "$keep" ] && [ "$entry" = "$keep" ] && continue
    base="$(basename -- "$entry")"
    if [ ! -e "$entry" ]; then
      do_rm "$entry"; step "removed broken link $base"; found=1
    elif [ "$(resolve_path "$entry")" = "$REPO_DIR" ]; then
      do_rm "$entry"; step "removed link $base"; found=1
    else
      step "left alone $base $G_ARROW $(resolve_path "$entry")"
    fi
  done
  [ "$found" -eq 0 ] && [ -z "$keep" ] && step "nothing to remove"
  return 0
}

verify_with_cli() {
  local cli="$1" dir="$2"
  [ -n "$cli" ] || return 0
  [ "$DRY_RUN" -eq 0 ] || return 0
  command -v "$cli" >/dev/null 2>&1 || return 0
  if "$cli" --list-extensions --extensions-dir "$dir" 2>/dev/null | grep -qx "$PUBLISHER.$NAME"; then
    step "$(tint verified "$C_GREEN"): $cli sees $PUBLISHER.$NAME in this directory"
  else
    step "$(tint note "$C_YELLOW"): $cli does not list it yet - restart the editor"
  fi
}

# link_target_dir <dir> <cli> ; honours CREATE_DIR / FORCE. Returns non-zero on failure.
link_target_dir() {
  local dir="$1" cli="${2:-}" link="$1/$LINK_NAME" resolved

  if [ ! -d "$dir" ]; then
    if [ "$CREATE_DIR" -eq 1 ]; then
      do_mkdir "$dir"; step "created directory"
    else
      step "$(tint skipped "$C_DIM"): directory does not exist (pass --create-dir to create it)"
      return 1
    fi
  fi

  ensure_build || return 1

  if [ -L "$link" ]; then
    if [ -e "$link" ] && [ "$(resolve_path "$link")" = "$REPO_DIR" ]; then
      step "$(tint "$G_OK already linked" "$C_GREEN") $G_ARROW this repo"
    else
      step "replacing existing link ($G_ARROW $(link_target "$link"))"
      do_rm "$link"
      do_link "$link" || return 1
    fi
  elif [ -e "$link" ]; then
    if [ "$FORCE" -eq 1 ]; then
      step "removing real directory (--force): $link"
      do_rmrf "$link"
      do_link "$link" || return 1
    else
      step "$(tint refused "$C_YELLOW"): $link exists as a real directory (an installed copy?)."
      step "         Inspect it, then re-run with --force to replace it."
      return 1
    fi
  else
    do_link "$link" || return 1
  fi

  prune_our_links "$dir" "$link"
  verify_with_cli "$cli" "$dir"
  return 0
}

unlink_target_dir() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    step "$(tint skipped "$C_DIM"): directory does not exist"
    return 0
  fi
  prune_our_links "$dir"
  return 0
}

# ---------- sentry-cli health / token advisory ----------
#
# Advisory only: the extension talks to Sentry itself and keeps its own token in
# SecretStorage or .sentry_viewer/local.json. sentry-cli is a convenience - it
# is where the extension's one-time token import reads from, and what uploads
# sourcemaps so production stack frames resolve to real files. Nothing here can
# fail a link.

# Print where a sentry-cli token lives. Never prints the token itself.
sentry_token_source() {
  if [ -n "${SENTRY_AUTH_TOKEN:-}" ]; then
    printf '%s\n' 'SENTRY_AUTH_TOKEN environment variable'
    return 0
  fi
  local file
  for file in "./.sentryclirc" "$HOME/.sentryclirc"; do
    if [ -f "$file" ] && grep -qE '^[[:space:]]*token[[:space:]]*=[[:space:]]*[^[:space:]]' "$file" 2>/dev/null; then
      abbrev_home "$file"; printf '\n'
      return 0
    fi
  done
  return 1
}

# Offer the verified install channels for this platform, running one on request.
offer_cli_install() {
  local os labels=() commands=() i n
  os="$(uname -s 2>/dev/null || echo unknown)"

  # npm first: this repo already needs Node, so it always applies.
  labels+=("npm install -g @sentry/cli"); commands+=("npm install -g @sentry/cli")
  case "$os" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        labels+=("brew install getsentry/tools/sentry-cli"); commands+=("brew install getsentry/tools/sentry-cli")
      fi
      labels+=("curl -sL https://sentry.io/get-cli/ | sh"); commands+=("curl -sL https://sentry.io/get-cli/ | sh")
      ;;
    MINGW*|MSYS*|CYGWIN*)
      if command -v scoop >/dev/null 2>&1; then
        labels+=("scoop install sentry-cli"); commands+=("scoop install sentry-cli")
      fi
      ;;
    *)
      labels+=("curl -sL https://sentry.io/get-cli/ | sh"); commands+=("curl -sL https://sentry.io/get-cli/ | sh")
      ;;
  esac

  step "install with:"
  n=1
  for i in "${labels[@]}"; do
    step "  $(tint "$n)" "$C_CYAN") $i"
    n=$((n + 1))
  done

  if [ "$DRY_RUN" -eq 1 ]; then
    step "$(tint "dry-run: not offering to install" "$C_DIM")"
    return 0
  fi
  if [ -z "$TTY_IN" ] || [ ! -t 1 ]; then
    step "$(tint "run one of the above, then re-run this command" "$C_DIM")"
    return 0
  fi

  local total="${#labels[@]}"
  prompt_read "  Install now? [1-$total, or N to skip] $G_PROMPT "
  case "$ANSWER" in
    ''|n|N|no|q|Q) step "$(tint skipped "$C_DIM")"; return 0 ;;
    *[!0-9]*) step "$(tint "not a choice: $ANSWER" "$C_YELLOW")"; return 0 ;;
  esac
  if [ "$ANSWER" -lt 1 ] || [ "$ANSWER" -gt "$total" ]; then
    step "$(tint "out of range: $ANSWER" "$C_YELLOW")"
    return 0
  fi

  local chosen="${commands[$((ANSWER - 1))]}"
  say ""
  step "running: $chosen"
  say ""
  if bash -c "$chosen"; then
    say ""
    if command -v sentry-cli >/dev/null 2>&1; then
      step "$(tint "$G_OK installed" "$C_GREEN") $(sentry-cli --version 2>/dev/null || echo 'sentry-cli')"
    else
      step "$(tint note "$C_YELLOW"): install reported success but sentry-cli is not on PATH yet."
      step "       Open a new terminal, or add npm's global bin directory to PATH."
    fi
  else
    say ""
    step "$(tint "install failed" "$C_YELLOW") - try another option above."
    case "$chosen" in
      npm*) step "       A global npm install may need sudo, or set a user prefix:"
            step "         npm config set prefix ~/.local && npm install -g @sentry/cli" ;;
      curl*) step "       The official installer writes to /usr/local/bin and may need sudo." ;;
    esac
  fi
  return 0
}

# Returns the number of problems found (0 = healthy CLI and a token on file).
# Link paths ignore the status; the standalone --cli-check action propagates it.
check_sentry_cli() {
  [ "$CLI_CHECK" -eq 1 ] || return 0
  local issues=0
  say ""
  say "  $(tint "Sentry CLI" "$C_BOLD") $(tint "(optional - token import and sourcemap uploads)" "$C_DIM")"

  local cli_path version
  cli_path="$(command -v sentry-cli 2>/dev/null || true)"
  if [ -n "$cli_path" ]; then
    if version="$(sentry-cli --version 2>/dev/null)"; then
      step "$(tint "$G_OK" "$C_GREEN") $version  $(tint "$cli_path" "$C_DIM")"
    else
      step "$(tint "$G_WARN" "$C_YELLOW") found at $cli_path but 'sentry-cli --version' failed - the binary looks broken"
      issues=$((issues + 1))
    fi
  else
    step "$(tint "$G_WARN not installed" "$C_YELLOW")"
    offer_cli_install
    cli_path="$(command -v sentry-cli 2>/dev/null || true)"
    [ -n "$cli_path" ] || issues=$((issues + 1))
  fi

  local source
  if source="$(sentry_token_source)"; then
    step "$(tint "$G_OK" "$C_GREEN") auth token on file $(tint "($source)" "$C_DIM")"
    step "$(tint "the extension can import it on first run: Sentry: Sign In" "$C_DIM")"
  else
    step "$(tint "$G_WARN no auth token on file" "$C_YELLOW")"
    if [ -n "$cli_path" ]; then
      step "       Create one at $(tint "https://sentry.io/settings/account/api/auth-tokens/" "$C_CYAN") then run:"
      step "         sentry-cli login"
    else
      step "       Create one at $(tint "https://sentry.io/settings/account/api/auth-tokens/" "$C_CYAN")"
    fi
    step "$(tint "or paste one straight into the extension: Sentry: Sign In" "$C_DIM")"
    issues=$((issues + 1))
  fi
  return "$issues"
}

# ---------- standalone health check (touches no links) ----------

if [ "$ACTION" = "clicheck" ]; then
  CLI_CHECK=1     # this action *is* the check, so --no-cli-check cannot mute it
  render_header
  status=0
  check_sentry_cli || status=$?
  say ""
  exit "$status"
fi

# ---------- non-interactive table ----------

if [ "$ACTION" = "list" ]; then
  collect_rows
  render_header
  render_table 0
  render_notes
  say ""
  render_summary
  if [ "$N_LINKED" -eq 0 ]; then
    say "  $(tint "Run" "$C_DIM") $(tint "npm run link" "$C_CYAN") $(tint "to symlink this repo into the editors found above." "$C_DIM")"
  fi
  say ""
  exit 0
fi

# ---------- interactive menu ----------

if [ "$ACTION" = "menu" ]; then
  while :; do
    collect_rows
    total="$(row_count)"
    render_header
    render_table 1
    render_notes
    say ""
    render_summary
    say ""
    [ "$DRY_RUN" -eq 1 ] && say "  $(tint "dry-run: no changes will be written" "$C_YELLOW")"
    prompt_read "  Row to change [1-$total] $(tint "$G_SEP" "$C_DIM") (c)heck sentry-cli $(tint "$G_SEP" "$C_DIM") (r)efresh $(tint "$G_SEP" "$C_DIM") (q)uit $G_PROMPT "

    case "$ANSWER" in
      q|Q|quit|exit) say ""; exit 0 ;;
      c|C|check) CLI_CHECK=1; check_sentry_cli || true; continue ;;
      r|R|refresh|"") continue ;;
      *[!0-9]*|"")
        say ""
        say "  $(tint "Not a row number: $ANSWER" "$C_YELLOW")"
        continue ;;
    esac
    if [ "$ANSWER" -lt 1 ] || [ "$ANSWER" -gt "$total" ]; then
      say ""
      say "  $(tint "Row $ANSWER is out of range (1-$total)" "$C_YELLOW")"
      continue
    fi

    sel_label="$(row_field "$ANSWER" 1)"
    sel_status="$(row_field "$ANSWER" 2)"
    sel_dir="$(row_field "$ANSWER" 3)"
    sel_cli="$(row_field "$ANSWER" 4)"

    say ""
    say "  $(tint "$sel_label" "$C_BOLD")  $(tint "$(abbrev_home "$sel_dir")" "$C_DIM")"
    status_style "$sel_status"
    say "  status: $(tint "$S_GLYPH $sel_status" "$S_COLOR")"
    while IFS="	" read -r state base detail; do
      [ -n "$state" ] || continue
      say "          $(tint "$state: $base $G_ARROW $detail" "$C_DIM")"
    done <<EOF
$(scan_dir "$sel_dir")
EOF

    # Describe what each action will do for this row's current state.
    link_hint="link this repo here"
    case "$sel_status" in
      linked)   link_hint="relink (already linked)" ;;
      stale)    link_hint="link current version, remove the older link" ;;
      copy)     link_hint="$(tint "replaces the installed copy" "$C_YELLOW")" ;;
      other)    link_hint="replace the foreign link" ;;
      absent)   link_hint="create the directory, then link" ;;
    esac

    say ""
    prompt_read "  (l)ink $(tint "- $link_hint" "$C_DIM") $(tint "$G_SEP" "$C_DIM") (u)nlink $(tint "$G_SEP" "$C_DIM") (b)ack $G_PROMPT "
    say ""

    case "$ANSWER" in
      l|L|link)
        # Confirm the two risky cases before touching anything. FORCE and
        # CREATE_DIR are restored afterwards so a "yes" here can never carry
        # over to a later row.
        saved_force="$FORCE"; saved_create="$CREATE_DIR"
        proceed=1
        if [ "$sel_status" = "copy" ]; then
          say "  $(tint "$G_WARN $sel_dir/$LINK_NAME is a real directory, not a link." "$C_YELLOW")"
          say "  $(tint "  Linking will delete it. If an editor installed it, it can be reinstalled." "$C_DIM")"
          prompt_read "  Delete it and link? [y/N] $G_PROMPT "
          case "$ANSWER" in y|Y|yes) FORCE=1 ;; *) proceed=0 ;; esac
          say ""
        fi
        if [ "$proceed" -eq 1 ] && [ ! -d "$sel_dir" ]; then
          prompt_read "  Directory does not exist. Create it? [y/N] $G_PROMPT "
          case "$ANSWER" in y|Y|yes) CREATE_DIR=1 ;; *) proceed=0 ;; esac
          say ""
        fi
        if [ "$proceed" -eq 1 ]; then
          say "  $(tint "$sel_label" "$C_BOLD")"
          if link_target_dir "$sel_dir" "$sel_cli"; then
            check_sentry_cli || true
          fi
        else
          say "  $(tint "cancelled" "$C_DIM")"
        fi
        FORCE="$saved_force"; CREATE_DIR="$saved_create"
        ;;
      u|U|unlink)
        say "  $(tint "$sel_label" "$C_BOLD")"
        unlink_target_dir "$sel_dir"
        ;;
      b|B|back|"") say "  $(tint "back" "$C_DIM")" ;;
      q|Q|quit|exit) say ""; exit 0 ;;
      *) say "  $(tint "Unknown choice: $ANSWER" "$C_YELLOW")" ;;
    esac
  done
fi

# ---------- batch install / uninstall ----------

TARGETS=""

add_target() {
  local dir="${1%/}" lbl="$2" cli="${3:-}"
  case "
$TARGETS" in
    *"
$dir	"*) return 0 ;;
  esac
  TARGETS="$TARGETS
$dir	$lbl	$cli"
}

for editor in $TARGET_EDITORS; do
  dir="$(resolve_dir "$editor")" || true
  add_target "$dir" "$(label_for "$editor")" "$(cli_for "$editor")"
done

while IFS= read -r p; do
  [ -n "$p" ] || continue
  add_target "$p" "Custom path" ""
done <<EOF
$CUSTOM_PATHS
EOF

if [ -z "$(printf '%s' "$TARGETS" | tr -d '[:space:]')" ] || [ "$DETECTED_ONLY" -eq 1 ]; then
  for editor in $ALL_EDITORS; do
    if dir="$(resolve_dir "$editor")"; then
      add_target "$dir" "$(label_for "$editor")" "$(cli_for "$editor")"
    fi
  done
fi

if [ -z "$(printf '%s' "$TARGETS" | tr -d '[:space:]')" ]; then
  echo "error: no editor extension directories found." >&2
  echo "       Use --path DIR, or a target flag together with --create-dir." >&2
  exit 1
fi

failures=0
say ""
while IFS="	" read -r dir label cli; do
  [ -n "$dir" ] || continue
  say "$(tint "$label" "$C_BOLD")  $(tint "$(abbrev_home "$dir")" "$C_DIM")"
  if [ "$ACTION" = "uninstall" ]; then
    unlink_target_dir "$dir"
  else
    link_target_dir "$dir" "$cli" || failures=$((failures + 1))
  fi
  say ""
done <<EOF
$TARGETS
EOF

if [ "$ACTION" = "uninstall" ]; then
  say "Done. Reload or restart your editor to drop the extension."
else
  if [ "$failures" -lt "$(printf '%s\n' "$TARGETS" | sed -n '/./p' | wc -l | tr -d ' ')" ]; then
    check_sentry_cli || true
  fi
  say ""
  say "Done. Run 'Developer: Reload Window' in each editor to load the current build."
  say "Tip: 'npm run watch' + reload gives a fast edit/test loop."
fi

[ "$failures" -gt 0 ] && exit 1
exit 0
