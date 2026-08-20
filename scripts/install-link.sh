#!/usr/bin/env bash
#
# Symlink this extension into local editor extension directories, so that
# "Developer: Reload Window" picks up each rebuild without repackaging.
#
# Portability notes:
#   * Works with bash 3.2 (stock macOS) upwards — no associative arrays,
#     no GNU-only flags such as `readlink -f`.
#   * VS Code and its forks keep extensions under the user's home directory on
#     every platform (only user-data lives in ~/Library or %APPDATA%), so the
#     same relative paths apply on Linux, macOS, and Windows (git-bash/MSYS).
#   * Also probes remote/WSL server directories (.vscode-server, …) and Linux
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
    G_OK="●"; G_WARN="▲"; G_OFF="○"; G_NONE="·"; G_ARROW="→"; G_ELLIPSIS="…"; G_SEP="·"
  else
    BX_TL="+"; BX_TR="+"; BX_BL="+"; BX_BR="+"; BX_H="-"; BX_V="|"
    BX_T="+"; BX_B="+"; BX_X="+"; BX_L="+"; BX_R="+"
    G_OK="*"; G_WARN="!"; G_OFF="o"; G_NONE="."; G_ARROW="->"; G_ELLIPSIS="..."; G_SEP="|"
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

# ---------- home roots (handles git-bash/MSYS where $HOME may differ) ----------

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

# Relative (to home) extension dirs per editor, most canonical first.
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

# Full candidate list: home roots x relative dirs.
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
ACTION="install"
DO_BUILD=1
CREATE_DIR=0
FORCE=0
DRY_RUN=0
DETECTED_ONLY=0

usage() {
  cat <<EOF
Symlink $PUBLISHER.$NAME v$VERSION into local editor extension directories.

USAGE
  scripts/install-link.sh [targets] [options]
  npm run link -- [targets] [options]

TARGETS (repeatable; default: --detected)
  --vscode                 ~/.vscode/extensions
  --vscode-insiders        ~/.vscode-insiders/extensions
  --vscodium               ~/.vscode-oss/extensions
  --cursor                 ~/.cursor/extensions
  --antigravity            ~/.antigravity/extensions
  --windsurf               ~/.windsurf/extensions
  --all                    every known editor above
  --detected               every known editor whose directory already exists
  --path DIR               a specific extensions directory

  Remote/WSL server dirs (.vscode-server/extensions, .cursor-server/…) and
  Linux Flatpak sandboxes are probed automatically, as is \$VSCODE_EXTENSIONS.

ACTIONS
  (default)                create or refresh the symlink
  --uninstall              remove this extension's symlink(s)
  --list                   show link status for every known editor

OPTIONS
  --no-build               skip 'npm run build' (dist/ must already exist)
  --create-dir             create the extensions directory if it is missing
  --force                  replace a real (non-symlink) directory at the target
  -n, --dry-run            print planned actions without changing anything
  --color WHEN             auto (default), always, or never
  --no-color               same as --color never (also honours \$NO_COLOR)
  --ascii                  plain ASCII table instead of box-drawing glyphs
  -h, --help               this help

EXAMPLES
  npm run link                      # every editor found on this machine
  npm run link -- --cursor          # Cursor only
  npm run link -- --antigravity --create-dir
  npm run link -- --path ~/.config/SomeFork/extensions
  npm run link -- --list
  npm run link -- --uninstall --all
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --vscode|--vscode-insiders|--vscodium|--cursor|--antigravity|--windsurf)
      TARGET_EDITORS="$TARGET_EDITORS ${1#--}" ;;
    --all)      TARGET_EDITORS="$TARGET_EDITORS $ALL_EDITORS" ;;
    --detected) DETECTED_ONLY=1 ;;
    --path)
      [ $# -ge 2 ] || { echo "error: --path needs a directory" >&2; exit 1; }
      CUSTOM_PATHS="$CUSTOM_PATHS
$(expand_tilde "$2")"; shift ;;
    --path=*)
      CUSTOM_PATHS="$CUSTOM_PATHS
$(expand_tilde "${1#--path=}")" ;;
    --uninstall|--remove|--unlink) ACTION="uninstall" ;;
    --list|--status)               ACTION="list" ;;
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
    -h|--help)     usage; exit 0 ;;
    *) echo "error: unknown option '$1' (try --help)" >&2; exit 1 ;;
  esac
  shift
done

init_style

say()  { printf '%s\n' "$*"; }
step() { printf '  %s\n' "$*"; }

# ---------- list ----------

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

if [ "$ACTION" = "list" ]; then
  width="$(term_width)"

  # Pass 1: gather rows as "label<TAB>status<TAB>path" plus notes.
  rows=""
  notes=""
  n_linked=0; n_unlinked=0; n_absent=0; n_attention=0
  col1=6; col3=9

  for editor in $ALL_EDITORS; do
    label="$(label_for "$editor")"
    dir="$(resolve_dir "$editor")" && exists=1 || exists=0
    shown_dir="$(abbrev_home "$dir")"
    status="absent"

    if [ "$exists" -eq 1 ]; then
      status="unlinked"
      entries="$(scan_dir "$dir")"
      while IFS="	" read -r state base detail; do
        [ -n "$state" ] || continue
        case "$state" in
          linked) status="linked" ;;
          stale)  [ "$status" = "linked" ] || status="stale" ;;
          copy)   [ "$status" = "linked" ] || status="copy" ;;
          other|broken) [ "$status" = "linked" ] || status="other" ;;
        esac
        case "$state" in
          linked) : ;;
          *) notes="$notes
$label	$state	$base	$detail" ;;
        esac
      done <<EOF
$entries
EOF
    fi

    case "$status" in
      linked)   n_linked=$((n_linked + 1)) ;;
      unlinked) n_unlinked=$((n_unlinked + 1)) ;;
      absent)   n_absent=$((n_absent + 1)) ;;
      *)        n_attention=$((n_attention + 1)) ;;
    esac

    [ "${#label}" -gt "$col1" ] && col1="${#label}"
    [ "${#shown_dir}" -gt "$col3" ] && col3="${#shown_dir}"
    rows="$rows
$label	$status	$shown_dir"
  done

  col2=8   # widest status word: "unlinked"
  # Fit within the terminal: 4 borders + 3 separators of padding = 10 columns.
  max_col3=$((width - col1 - col2 - 12))
  [ "$max_col3" -lt 20 ] && max_col3=20
  [ "$col3" -gt "$max_col3" ] && col3="$max_col3"

  # $1 = left corner, $2 = junction, $3 = right corner
  rule() {
    say "  $1$(repeat_char $((col1 + 2)) "$BX_H")$2$(repeat_char $((col2 + 4)) "$BX_H")$2$(repeat_char $((col3 + 2)) "$BX_H")$3"
  }

  say ""
  say "  $(tint "$PUBLISHER.$NAME" "$C_BOLD") $(tint "v$VERSION" "$C_DIM")"
  say "  $(tint "$(abbrev_home "$REPO_DIR")" "$C_DIM")"
  say ""

  rule "$BX_TL" "$BX_T" "$BX_TR"
  say "  $BX_V $(tint "$(pad EDITOR "$col1")" "$C_DIM") $BX_V $(tint "$(pad STATUS $((col2 + 2)))" "$C_DIM") $BX_V $(tint "$(pad 'EXTENSIONS DIRECTORY' "$col3")" "$C_DIM") $BX_V"
  rule "$BX_L" "$BX_X" "$BX_R"

  while IFS="	" read -r label status shown_dir; do
    [ -n "$label" ] || continue
    case "$status" in
      linked)   glyph="$G_OK";   color="$C_GREEN";  path_color="" ;;
      unlinked) glyph="$G_OFF";  color="$C_DIM";    path_color="" ;;
      absent)   glyph="$G_NONE"; color="$C_DIM";    path_color="$C_DIM" ;;
      *)        glyph="$G_WARN"; color="$C_YELLOW"; path_color="" ;;
    esac
    say "  $BX_V $(pad "$label" "$col1") $BX_V $(tint "$glyph $(pad "$status" "$col2")" "$color") $BX_V $(tint "$(pad "$(truncate_str "$shown_dir" "$col3")" "$col3")" "$path_color") $BX_V"
  done <<EOF
$rows
EOF

  rule "$BX_BL" "$BX_B" "$BX_BR"

  if [ -n "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
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
      say "    $(tint "$(pad "$word" 15)" "$color")$(pad "$label" $((col1 + 2)))$(tint "$base $G_ARROW $detail" "$C_DIM")"
    done <<EOF
$notes
EOF
  fi

  say ""
  summary="$(tint "$n_linked linked" "$C_GREEN")"
  sep=" $(tint "$G_SEP" "$C_DIM") "
  [ "$n_attention" -gt 0 ] && summary="$summary$sep$(tint "$n_attention need attention" "$C_YELLOW")"
  [ "$n_unlinked" -gt 0 ] && summary="$summary$sep$n_unlinked unlinked"
  [ "$n_absent" -gt 0 ] && summary="$summary$sep$(tint "$n_absent not installed" "$C_DIM")"
  say "  $summary"
  if [ "$n_linked" -eq 0 ]; then
    say "  $(tint "Run" "$C_DIM") $(tint "npm run link" "$C_CYAN") $(tint "to symlink this repo into the editors found above." "$C_DIM")"
  fi
  say ""
  exit 0
fi

# ---------- resolve targets (newline-delimited "dir<TAB>label<TAB>cli") ----------

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

# ---------- build ----------

if [ "$ACTION" = "install" ]; then
  if [ "$DO_BUILD" -eq 1 ]; then
    say "Building extension…"
    if [ "$DRY_RUN" -eq 1 ]; then
      step "would run: npm run build  (in $REPO_DIR)"
    else
      ( cd "$REPO_DIR" && npm run build >/dev/null ) || { echo "error: build failed" >&2; exit 1; }
      step "dist/ built"
    fi
  elif [ ! -f "$REPO_DIR/dist/extension.js" ]; then
    echo "warning: dist/extension.js is missing and --no-build was given;" >&2
    echo "         the editor will fail to activate this extension." >&2
  fi
  say ""
fi

# ---------- link helpers ----------

do_rm()  { if [ "$DRY_RUN" -eq 1 ]; then step "would remove: $1"; else rm -f -- "$1"; fi; }
do_rmrf(){ if [ "$DRY_RUN" -eq 1 ]; then step "would remove tree: $1"; else rm -rf -- "$1"; fi; }
do_mkdir(){ if [ "$DRY_RUN" -eq 1 ]; then step "would create: $1"; else mkdir -p -- "$1"; fi; }

do_link() {
  local link="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    step "would link: $link -> $REPO_DIR"
    return 0
  fi
  if ln -s -- "$REPO_DIR" "$link" 2>/dev/null; then
    # MSYS/git-bash silently *copies* unless MSYS=winsymlinks:nativestrict,
    # which would freeze a stale snapshot instead of tracking the repo.
    if [ ! -L "$link" ]; then
      step "$(tint "error" "$C_RED"): '$link' was created as a copy, not a symlink."
      step "       Your shell does not support symlinks here. Either:"
      step "         export MSYS=winsymlinks:nativestrict   (git-bash, then retry)"
      step "       or create a junction from an elevated cmd.exe:"
      step "         mklink /J \"$link\" \"$REPO_DIR\""
      do_rmrf "$link"
      return 1
    fi
    step "$(tint "$G_OK linked" "$C_GREEN") $LINK_NAME $G_ARROW $(tint "$REPO_DIR" "$C_DIM")"
    return 0
  fi
  step "$(tint "error" "$C_RED"): could not create symlink at $link"
  case "$(uname -s 2>/dev/null || echo unknown)" in
    MINGW*|MSYS*|CYGWIN*)
      step "       On Windows, symlinks need Developer Mode or an elevated shell."
      step "       Alternative (cmd.exe as admin):"
      step "         mklink /J \"$link\" \"$REPO_DIR\""
      ;;
    *)
      step "       Check write permission on $(dirname -- "$link")."
      ;;
  esac
  return 1
}

# Remove this extension's links (any version) that point at this repo,
# plus broken links for the same id. Never touches real directories.
prune_our_links() {
  local dir="$1" keep="${2:-}" entry base
  for entry in "$dir"/$ID_GLOB; do
    [ -L "$entry" ] || continue
    [ -n "$keep" ] && [ "$entry" = "$keep" ] && continue
    base="$(basename -- "$entry")"
    if [ ! -e "$entry" ]; then
      do_rm "$entry"
      step "removed broken link $base"
    elif [ "$(resolve_path "$entry")" = "$REPO_DIR" ]; then
      do_rm "$entry"
      step "removed link $base"
    else
      step "left alone $base -> $(resolve_path "$entry")"
    fi
  done
  return 0
}

# ---------- install / uninstall ----------

failures=0

while IFS="	" read -r dir label cli; do
  [ -n "$dir" ] || continue
  link="$dir/$LINK_NAME"
  say "$(tint "$label" "$C_BOLD")  $(tint "$(abbrev_home "$dir")" "$C_DIM")"

  if [ ! -d "$dir" ]; then
    if [ "$CREATE_DIR" -eq 1 ]; then
      do_mkdir "$dir"
      step "created directory"
    else
      step "$(tint "skipped" "$C_DIM"): directory does not exist (pass --create-dir to create it)"
      failures=$((failures + 1))
      say ""
      continue
    fi
  fi

  if [ "$ACTION" = "uninstall" ]; then
    prune_our_links "$dir"
    say ""
    continue
  fi

  if [ -L "$link" ]; then
    if [ -e "$link" ] && [ "$(resolve_path "$link")" = "$REPO_DIR" ]; then
      step "$(tint "$G_OK already linked" "$C_GREEN") $G_ARROW this repo"
    else
      step "replacing existing link (-> $(link_target "$link"))"
      do_rm "$link"
      do_link "$link" || failures=$((failures + 1))
    fi
  elif [ -e "$link" ]; then
    # A real directory: most likely a packaged/marketplace copy of the same id.
    if [ "$FORCE" -eq 1 ]; then
      step "removing real directory (--force): $link"
      do_rmrf "$link"
      do_link "$link" || failures=$((failures + 1))
    else
      step "$(tint "refused" "$C_YELLOW"): $link exists as a real directory (an installed copy?)."
      step "         Inspect it, then re-run with --force to replace it."
      failures=$((failures + 1))
      say ""
      continue
    fi
  else
    do_link "$link" || failures=$((failures + 1))
  fi

  # Drop links from older versions so the editor cannot load two copies.
  prune_our_links "$dir" "$link"

  # Verify against the directory we actually linked into, not the CLI default.
  if [ -n "$cli" ] && [ "$DRY_RUN" -eq 0 ] && command -v "$cli" >/dev/null 2>&1; then
    if "$cli" --list-extensions --extensions-dir "$dir" 2>/dev/null | grep -qx "$PUBLISHER.$NAME"; then
      step "$(tint "verified" "$C_GREEN"): $cli sees $PUBLISHER.$NAME in this directory"
    else
      step "$(tint "note" "$C_YELLOW"): $cli does not list it yet — restart the editor"
    fi
  fi
  say ""
done <<EOF
$TARGETS
EOF

if [ "$ACTION" = "uninstall" ]; then
  say "Done. Reload or restart your editor to drop the extension."
else
  say "Done. Run 'Developer: Reload Window' in each editor to load the current build."
  say "Tip: 'npm run watch' + reload gives a fast edit/test loop."
fi

[ "$failures" -gt 0 ] && exit 1
exit 0
