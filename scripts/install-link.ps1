#!/usr/bin/env pwsh
#
# Link this extension into local editor extension directories, so that
# "Developer: Reload Window" picks up each rebuild without repackaging.
#
# PowerShell counterpart of install-link.sh, with the same flags, states and
# safety rules. Runs on Windows PowerShell 5.1 and PowerShell 7+.
#
# Windows notes:
#   * A directory symlink normally needs Developer Mode or an elevated shell.
#     When symlink creation is denied we fall back to a directory *junction*,
#     which needs no privileges and works the same for VS Code.
#   * Links are deleted with Directory.Delete(link, recursive:$false) so the
#     repository behind the link can never be removed by accident.
#
# Run with -Help for usage.

#Requires -Version 5.1

param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Arguments)

$ErrorActionPreference = 'Stop'

$RepoDir = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path.TrimEnd('\', '/')

# ---------- extension identity (from package.json) ----------

$pkgPath = Join-Path $RepoDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgPath)) {
    Write-Error "package.json not found at $pkgPath"
    exit 1
}
$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
if (-not $pkg.publisher -or -not $pkg.name -or -not $pkg.version) {
    Write-Error 'package.json needs publisher, name and version'
    exit 1
}
$Publisher = $pkg.publisher
$Name = $pkg.name
$Version = $pkg.version
$ExtId = "$Publisher.$Name"
$LinkName = "$ExtId-$Version"
$IdPrefix = "$ExtId-"

# ---------- options ----------

$Opt = @{
    Editors     = New-Object System.Collections.ArrayList
    Paths       = New-Object System.Collections.ArrayList
    Action      = ''          # '' (=list/menu) | install | uninstall | list
    Build       = $true
    CreateDir   = $false
    Force       = $false
    DryRun      = $false
    Detected    = $false
    Interactive = 'auto'      # auto | never
    ColorMode   = 'auto'      # auto | always | never
    GlyphMode   = 'auto'      # auto | unicode | ascii
    Junction    = $false      # force junctions instead of symlinks
    CliCheck    = $true       # sentry-cli health/token advisory after linking
}

$AllEditors = @('vscode', 'vscode-insiders', 'vscodium', 'cursor', 'antigravity', 'windsurf')

function Show-Usage {
    @"
Link $ExtId v$Version into local editor extension directories.

USAGE
  pwsh -File scripts/install-link.ps1 [targets] [options]
  npm run links                       # interactive picker (this is the default)
  npm run link -- [targets]           # non-interactive install

TARGETS (repeatable)
  --vscode              --vscode-insiders     --vscodium
  --cursor              --antigravity         --windsurf
  --all                 every known editor above
  --detected            every known editor whose directory already exists
  --path DIR            a specific extensions directory

ACTIONS
  --install             link the given targets (implied by any target flag)
  --uninstall           remove this extension's links
  --list                status table; interactive when run on a console
  --plain               status table only, never interactive

OPTIONS
  --no-build            skip 'npm run build' (dist\ must already exist)
  --create-dir          create the extensions directory if it is missing
  --force               replace a real (non-link) directory at the target
  --junction            always use a directory junction (never needs elevation)
  -n, --dry-run         print planned actions without changing anything
  --color WHEN          auto (default), always, or never
  --no-color            same as --color never (also honours `$env:NO_COLOR)
  --ascii               plain ASCII table instead of box-drawing glyphs
  --no-cli-check        skip the sentry-cli health/token advisory after linking
  -h, --help            this help

CHECKS
  --cli-check, --doctor report sentry-cli health and whether a token is on file,
                        without touching any links. Exits non-zero when the CLI
                        is missing/broken or no token was found, so it is usable
                        as a scripted precondition.

PowerShell-style switches (-Cursor, -All, -DryRun, ...) are accepted too.
"@ | Write-Host
}

# Accept both --kebab-case (parity with the shell script) and -PascalCase.
function Get-Normalized([string] $token) {
    return ($token -replace '^-{1,2}', '').ToLowerInvariant()
}

$i = 0
$argv = @()
if ($Arguments) { $argv = $Arguments }
while ($i -lt $argv.Count) {
    $raw = $argv[$i]
    $flag = Get-Normalized $raw
    switch ($flag) {
        'vscode'           { [void]$Opt.Editors.Add('vscode');          if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'vscodeinsiders'   { [void]$Opt.Editors.Add('vscode-insiders'); if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'vscode-insiders'  { [void]$Opt.Editors.Add('vscode-insiders'); if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'vscodium'         { [void]$Opt.Editors.Add('vscodium');        if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'cursor'           { [void]$Opt.Editors.Add('cursor');          if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'antigravity'      { [void]$Opt.Editors.Add('antigravity');     if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'windsurf'         { [void]$Opt.Editors.Add('windsurf');        if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'all'              { foreach ($e in $AllEditors) { [void]$Opt.Editors.Add($e) }; if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'detected'         { $Opt.Detected = $true; if (-not $Opt.Action) { $Opt.Action = 'install' } }
        'path' {
            if ($i + 1 -ge $argv.Count) { Write-Error 'error: --path needs a directory'; exit 1 }
            [void]$Opt.Paths.Add($argv[$i + 1]); $i++
            if (-not $Opt.Action) { $Opt.Action = 'install' }
        }
        'install'          { $Opt.Action = 'install' }
        'uninstall'        { $Opt.Action = 'uninstall' }
        'remove'           { $Opt.Action = 'uninstall' }
        'unlink'           { $Opt.Action = 'uninstall' }
        'list'             { $Opt.Action = 'list' }
        'status'           { $Opt.Action = 'list' }
        'plain'            { $Opt.Action = 'list'; $Opt.Interactive = 'never' }
        'nointeractive'    { $Opt.Action = 'list'; $Opt.Interactive = 'never' }
        'no-interactive'   { $Opt.Action = 'list'; $Opt.Interactive = 'never' }
        'nobuild'          { $Opt.Build = $false }
        'no-build'         { $Opt.Build = $false }
        'createdir'        { $Opt.CreateDir = $true }
        'create-dir'       { $Opt.CreateDir = $true }
        'force'            { $Opt.Force = $true }
        'junction'         { $Opt.Junction = $true }
        'dryrun'           { $Opt.DryRun = $true }
        'dry-run'          { $Opt.DryRun = $true }
        'n'                { $Opt.DryRun = $true }
        'color' {
            if ($i + 1 -ge $argv.Count) { Write-Error 'error: --color needs auto|always|never'; exit 1 }
            $Opt.ColorMode = $argv[$i + 1].ToLowerInvariant(); $i++
        }
        'nocolor'          { $Opt.ColorMode = 'never' }
        'no-color'         { $Opt.ColorMode = 'never' }
        'ascii'            { $Opt.GlyphMode = 'ascii' }
        'noclicheck'       { $Opt.CliCheck = $false }
        'no-cli-check'     { $Opt.CliCheck = $false }
        'skipclicheck'     { $Opt.CliCheck = $false }
        'clicheck'         { $Opt.Action = 'clicheck' }
        'cli-check'        { $Opt.Action = 'clicheck' }
        'checkcli'         { $Opt.Action = 'clicheck' }
        'check-cli'        { $Opt.Action = 'clicheck' }
        'doctor'           { $Opt.Action = 'clicheck' }
        'help'             { Show-Usage; exit 0 }
        'h'                { Show-Usage; exit 0 }
        default {
            if ($flag -like 'color=*')  { $Opt.ColorMode = ($flag -replace '^color=', '') }
            elseif ($flag -like 'path=*') { [void]$Opt.Paths.Add(($raw -replace '^-{1,2}[Pp]ath=', '')); if (-not $Opt.Action) { $Opt.Action = 'install' } }
            else { Write-Host "error: unknown option '$raw' (try --help)"; exit 1 }
        }
    }
    $i++
}
if (-not $Opt.Action) { $Opt.Action = 'list' }

# ---------- presentation ----------

$script:Style = @{}

function Get-PlatformKind {
    # $IsWindows/$IsMacOS only exist in PowerShell 6+; 5.1 is Windows-only.
    if (Get-Variable -Name 'IsWindows' -ErrorAction SilentlyContinue) {
        if ($IsWindows) { return 'windows' }
        if ($IsMacOS)   { return 'macos' }
        return 'linux'
    }
    return 'windows'
}

function Test-ColorSupported {
    if ($Opt.ColorMode -eq 'never')  { return $false }
    if ($Opt.ColorMode -eq 'always') { return $true }
    if ($env:NO_COLOR) { return $false }
    try { if ([Console]::IsOutputRedirected) { return $false } } catch { }
    if ($env:WT_SESSION -or $env:TERM_PROGRAM -or $env:ConEmuANSI -eq 'ON') { return $true }
    if ((Get-PlatformKind) -ne 'windows') {
        # Match install-link.sh: on Unix an unset or dumb TERM means no color.
        return ($env:TERM -and $env:TERM -ne 'dumb')
    }
    if ($env:TERM -and $env:TERM -ne 'dumb') { return $true }
    try { if ($Host.UI.SupportsVirtualTerminal) { return $true } } catch { }
    return $false
}

function Test-UnicodeSupported {
    if ($Opt.GlyphMode -eq 'ascii')   { return $false }
    if ($Opt.GlyphMode -eq 'unicode') { return $true }
    if ((Get-PlatformKind) -ne 'windows') {
        # Match install-link.sh: on Unix the locale decides, and an unset or
        # non-UTF-8 locale means ASCII. Console encoding is not a usable signal
        # there because .NET reports UTF-8 regardless of LANG.
        $locale = $env:LC_ALL
        if (-not $locale) { $locale = $env:LC_CTYPE }
        if (-not $locale) { $locale = $env:LANG }
        return [bool]($locale -match '(?i)utf-?8')
    }
    if ($env:WT_SESSION -or $env:TERM_PROGRAM) { return $true }
    try {
        $enc = [Console]::OutputEncoding
        if ($enc -and ($enc.CodePage -eq 65001 -or $enc.WebName -like 'utf*')) { return $true }
    } catch { }
    return $false
}

function Initialize-Style {
    $esc = [char]27
    if (Test-ColorSupported) {
        $script:Style.Reset  = "$esc[0m";  $script:Style.Bold   = "$esc[1m"
        $script:Style.Dim    = "$esc[2m";  $script:Style.Green  = "$esc[32m"
        $script:Style.Yellow = "$esc[33m"; $script:Style.Red    = "$esc[31m"
        $script:Style.Cyan   = "$esc[36m"
    } else {
        foreach ($k in @('Reset', 'Bold', 'Dim', 'Green', 'Yellow', 'Red', 'Cyan')) { $script:Style[$k] = '' }
    }
    if (Test-UnicodeSupported) {
        $script:Style.TL = [char]0x256D; $script:Style.TR = [char]0x256E
        $script:Style.BL = [char]0x2570; $script:Style.BR = [char]0x256F
        $script:Style.H  = [char]0x2500; $script:Style.V  = [char]0x2502
        $script:Style.T  = [char]0x252C; $script:Style.B  = [char]0x2534
        $script:Style.X  = [char]0x253C; $script:Style.L  = [char]0x251C
        $script:Style.R  = [char]0x2524
        $script:Style.Ok = [char]0x25CF; $script:Style.Warn = [char]0x25B2
        $script:Style.Off = [char]0x25CB; $script:Style.None = [char]0x00B7
        $script:Style.Arrow = [char]0x2192; $script:Style.Ellipsis = [char]0x2026
        $script:Style.Sep = [char]0x00B7; $script:Style.Prompt = [char]0x203A
    } else {
        $script:Style.TL = '+'; $script:Style.TR = '+'; $script:Style.BL = '+'; $script:Style.BR = '+'
        $script:Style.H = '-'; $script:Style.V = '|'
        $script:Style.T = '+'; $script:Style.B = '+'; $script:Style.X = '+'
        $script:Style.L = '+'; $script:Style.R = '+'
        $script:Style.Ok = '*'; $script:Style.Warn = '!'; $script:Style.Off = 'o'; $script:Style.None = '.'
        $script:Style.Arrow = '->'; $script:Style.Ellipsis = '...'; $script:Style.Sep = '|'; $script:Style.Prompt = '>'
    }
}
Initialize-Style

function Get-Tinted([string] $text, [string] $color) {
    if ($color) { return "$color$text$($script:Style.Reset)" }
    return $text
}

function Write-Line([string] $text = '') { Write-Host $text }
function Write-Step([string] $text) { Write-Host "  $text" }

function Get-TermWidth {
    $w = 0
    try { $w = [Console]::WindowWidth } catch { $w = 0 }
    if ($w -lt 60) { $w = 100 }
    return $w
}

function Get-Repeated([int] $count, [string] $char) {
    if ($count -le 0) { return '' }
    return ($char * $count)
}

function Get-Truncated([string] $s, [int] $max) {
    if ($s.Length -le $max) { return $s }
    return $s.Substring(0, [Math]::Max(0, $max - 1)) + $script:Style.Ellipsis
}

function Get-HomeRoots {
    $roots = New-Object System.Collections.ArrayList
    foreach ($candidate in @($env:USERPROFILE, $env:HOME, $HOME)) {
        if ($candidate) {
            $trimmed = $candidate.TrimEnd('\', '/')
            if ($trimmed -and -not ($roots -contains $trimmed)) { [void]$roots.Add($trimmed) }
        }
    }
    return $roots
}

function Get-AbbreviatedPath([string] $path) {
    foreach ($root in Get-HomeRoots) {
        if ($path -and $path.Length -gt $root.Length) {
            if ($path.Substring(0, $root.Length) -ieq $root) {
                return '~' + $path.Substring($root.Length)
            }
        }
    }
    return $path
}

# ---------- editor discovery ----------

function Get-EditorLabel([string] $editor) {
    switch ($editor) {
        'vscode'          { 'VS Code' }
        'vscode-insiders' { 'VS Code Insiders' }
        'vscodium'        { 'VSCodium' }
        'cursor'          { 'Cursor' }
        'antigravity'     { 'Antigravity' }
        'windsurf'        { 'Windsurf' }
        default           { $editor }
    }
}

function Get-EditorCli([string] $editor) {
    switch ($editor) {
        'vscode'          { 'code' }
        'vscode-insiders' { 'code-insiders' }
        'vscodium'        { 'codium' }
        'cursor'          { 'cursor' }
        'antigravity'     { 'antigravity' }
        'windsurf'        { 'windsurf' }
        default           { '' }
    }
}

# Relative to a home root. These forks use the same layout on every platform;
# forward slashes are valid on Windows too, so no separator juggling is needed.
function Get-EditorRelativeDirs([string] $editor) {
    switch ($editor) {
        'vscode'          { @('.vscode/extensions', '.vscode-server/extensions') }
        'vscode-insiders' { @('.vscode-insiders/extensions', '.vscode-server-insiders/extensions') }
        'vscodium'        { @('.vscode-oss/extensions', '.vscodium/extensions', '.vscodium-server/extensions') }
        'cursor'          { @('.cursor/extensions', '.cursor-server/extensions') }
        'antigravity'     { @('.antigravity/extensions', '.antigravity-server/extensions', '.antigravity-insiders/extensions') }
        'windsurf'        { @('.windsurf/extensions', '.windsurf-server/extensions') }
        default           { @() }
    }
}

function Get-EditorCandidates([string] $editor) {
    $out = New-Object System.Collections.ArrayList
    foreach ($root in Get-HomeRoots) {
        foreach ($rel in Get-EditorRelativeDirs $editor) {
            [void]$out.Add((Join-Path $root $rel))
        }
    }
    return $out
}

# First existing candidate, else the canonical one. Exists flag reported separately.
function Get-EditorDir([string] $editor) {
    if ($editor -eq 'vscode' -and $env:VSCODE_EXTENSIONS) {
        $override = $env:VSCODE_EXTENSIONS.TrimEnd('\', '/')
        return [pscustomobject]@{ Dir = $override; Exists = (Test-Path -LiteralPath $override -PathType Container) }
    }
    $first = ''
    foreach ($candidate in Get-EditorCandidates $editor) {
        if (-not $first) { $first = $candidate }
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            return [pscustomobject]@{ Dir = $candidate; Exists = $true }
        }
    }
    return [pscustomobject]@{ Dir = $first; Exists = $false }
}

# ---------- link inspection ----------

function Test-IsLink($item) {
    if (-not $item) { return $false }
    return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq [System.IO.FileAttributes]::ReparsePoint)
}

function Get-LinkTargetPath($item) {
    $target = $null
    foreach ($prop in @('LinkTarget', 'Target')) {
        if ($item.PSObject.Properties.Name -contains $prop) {
            $value = $item.$prop
            if ($value) {
                if ($value -is [array]) { if ($value.Count -gt 0) { $target = [string]$value[0] } }
                else { $target = [string]$value }
            }
            if ($target) { break }
        }
    }
    if (-not $target) { return '' }
    try {
        if (-not [System.IO.Path]::IsPathRooted($target)) {
            $target = Join-Path (Split-Path -Parent $item.FullName) $target
        }
        return ([System.IO.Path]::GetFullPath($target)).TrimEnd('\', '/')
    } catch {
        return $target.TrimEnd('\', '/')
    }
}

function Test-PointsAtRepo($item) {
    $target = Get-LinkTargetPath $item
    if (-not $target) { return $false }
    return ($target -ieq $RepoDir)
}

# Entries for our extension id: state = linked | stale | copy | other | broken
function Get-DirEntries([string] $dir) {
    $result = New-Object System.Collections.ArrayList
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $result }
    $children = @()
    try { $children = Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop | Where-Object { $_.Name -like "$IdPrefix*" } } catch { return $result }
    foreach ($item in $children) {
        $base = $item.Name
        if (Test-IsLink $item) {
            $target = Get-LinkTargetPath $item
            if (-not $target -or -not (Test-Path -LiteralPath $target)) {
                [void]$result.Add([pscustomobject]@{ State = 'broken'; Base = $base; Detail = $target; Full = $item.FullName })
                continue
            }
            if ($target -ieq $RepoDir) {
                if ($base -ieq $LinkName) {
                    [void]$result.Add([pscustomobject]@{ State = 'linked'; Base = $base; Detail = 'this repo'; Full = $item.FullName })
                } else {
                    [void]$result.Add([pscustomobject]@{ State = 'stale'; Base = $base; Detail = 'this repo (older version)'; Full = $item.FullName })
                }
            } else {
                [void]$result.Add([pscustomobject]@{ State = 'other'; Base = $base; Detail = $target; Full = $item.FullName })
            }
        } else {
            [void]$result.Add([pscustomobject]@{ State = 'copy'; Base = $base; Detail = 'real directory, not a link'; Full = $item.FullName })
        }
    }
    return $result
}

function Get-DirStatus([string] $dir) {
    $status = 'unlinked'
    foreach ($entry in Get-DirEntries $dir) {
        switch ($entry.State) {
            'linked' { $status = 'linked' }
            'stale'  { if ($status -ne 'linked') { $status = 'stale' } }
            'copy'   { if ($status -ne 'linked') { $status = 'copy' } }
            default  { if ($status -ne 'linked') { $status = 'other' } }
        }
    }
    return $status
}

# ---------- rows ----------

function Get-Rows {
    $rows = New-Object System.Collections.ArrayList
    foreach ($editor in $AllEditors) {
        $info = Get-EditorDir $editor
        $status = 'absent'
        if ($info.Exists) { $status = Get-DirStatus $info.Dir }
        [void]$rows.Add([pscustomobject]@{
            Label  = Get-EditorLabel $editor
            Status = $status
            Dir    = $info.Dir
            Cli    = Get-EditorCli $editor
        })
    }
    foreach ($p in $Opt.Paths) {
        $full = $p
        try { $full = [System.IO.Path]::GetFullPath($p) } catch { }
        $full = $full.TrimEnd('\', '/')
        $status = 'absent'
        if (Test-Path -LiteralPath $full -PathType Container) { $status = Get-DirStatus $full }
        [void]$rows.Add([pscustomobject]@{ Label = 'Custom path'; Status = $status; Dir = $full; Cli = '' })
    }
    return $rows
}

function Get-StatusStyle([string] $status) {
    switch ($status) {
        'linked'   { return [pscustomobject]@{ Glyph = $script:Style.Ok;   Color = $script:Style.Green;  PathColor = '' } }
        'unlinked' { return [pscustomobject]@{ Glyph = $script:Style.Off;  Color = $script:Style.Dim;    PathColor = '' } }
        'absent'   { return [pscustomobject]@{ Glyph = $script:Style.None; Color = $script:Style.Dim;    PathColor = $script:Style.Dim } }
        default    { return [pscustomobject]@{ Glyph = $script:Style.Warn; Color = $script:Style.Yellow; PathColor = '' } }
    }
}

function Write-Header {
    Write-Line ''
    Write-Line ("  " + (Get-Tinted $ExtId $script:Style.Bold) + " " + (Get-Tinted "v$Version" $script:Style.Dim))
    Write-Line ("  " + (Get-Tinted (Get-AbbreviatedPath $RepoDir) $script:Style.Dim))
    Write-Line ''
}

function Write-Table($rows, [bool] $numbered) {
    $s = $script:Style
    $col0 = ([string]$rows.Count).Length
    $col1 = 6; $col2 = 8; $col3 = 9
    foreach ($row in $rows) {
        $shown = Get-AbbreviatedPath $row.Dir
        if ($row.Label.Length -gt $col1) { $col1 = $row.Label.Length }
        if ($shown.Length -gt $col3) { $col3 = $shown.Length }
    }
    $maxCol3 = (Get-TermWidth) - $col1 - $col2 - 12
    if ($numbered) { $maxCol3 = $maxCol3 - $col0 - 3 }
    if ($maxCol3 -lt 20) { $maxCol3 = 20 }
    if ($col3 -gt $maxCol3) { $col3 = $maxCol3 }

    function Write-Rule([string] $left, [string] $junction, [string] $right) {
        $line = ''
        if ($numbered) { $line += (Get-Repeated ($col0 + 2) $s.H) + $junction }
        $line += (Get-Repeated ($col1 + 2) $s.H) + $junction
        $line += (Get-Repeated ($col2 + 4) $s.H) + $junction
        $line += (Get-Repeated ($col3 + 2) $s.H)
        Write-Line ("  " + $left + $line + $right)
    }

    Write-Rule $s.TL $s.T $s.TR
    $head = ''
    if ($numbered) { $head = "$($s.V) " + (Get-Tinted ('#'.PadRight($col0)) $s.Dim) + " " }
    Write-Line ("  $head$($s.V) " + (Get-Tinted ('EDITOR'.PadRight($col1)) $s.Dim) +
                " $($s.V) " + (Get-Tinted ('STATUS'.PadRight($col2 + 2)) $s.Dim) +
                " $($s.V) " + (Get-Tinted ('EXTENSIONS DIRECTORY'.PadRight($col3)) $s.Dim) + " $($s.V)")
    Write-Rule $s.L $s.X $s.R

    $n = 0
    foreach ($row in $rows) {
        $n++
        $style = Get-StatusStyle $row.Status
        $num = ''
        if ($numbered) { $num = "$($s.V) " + (Get-Tinted ([string]$n).PadRight($col0) $s.Cyan) + " " }
        $statusCell = Get-Tinted ("$($style.Glyph) " + $row.Status.PadRight($col2)) $style.Color
        $pathCell = Get-Tinted ((Get-Truncated (Get-AbbreviatedPath $row.Dir) $col3).PadRight($col3)) $style.PathColor
        Write-Line ("  $num$($s.V) " + $row.Label.PadRight($col1) + " $($s.V) $statusCell $($s.V) $pathCell $($s.V)")
    }
    Write-Rule $s.BL $s.B $s.BR
}

function Write-Notes($rows) {
    $notes = New-Object System.Collections.ArrayList
    foreach ($row in $rows) {
        foreach ($entry in Get-DirEntries $row.Dir) {
            if ($entry.State -ne 'linked') {
                [void]$notes.Add([pscustomobject]@{ Label = $row.Label; Entry = $entry })
            }
        }
    }
    if ($notes.Count -eq 0) { return }
    Write-Line ''
    Write-Line ("  " + (Get-Tinted 'Notes' $script:Style.Bold))
    foreach ($note in $notes) {
        switch ($note.Entry.State) {
            'stale'  { $color = $script:Style.Yellow; $word = 'stale link' }
            'broken' { $color = $script:Style.Red;    $word = 'broken link' }
            'other'  { $color = $script:Style.Yellow; $word = 'foreign link' }
            'copy'   { $color = $script:Style.Yellow; $word = 'installed copy' }
            default  { $color = '';                   $word = $note.Entry.State }
        }
        $detail = "$($note.Entry.Base) $($script:Style.Arrow) $($note.Entry.Detail)"
        Write-Line ("    " + (Get-Tinted $word.PadRight(15) $color) + $note.Label.PadRight(20) + (Get-Tinted $detail $script:Style.Dim))
    }
}

function Write-Summary($rows) {
    $linked = 0; $unlinked = 0; $absent = 0; $attention = 0
    foreach ($row in $rows) {
        switch ($row.Status) {
            'linked'   { $linked++ }
            'unlinked' { $unlinked++ }
            'absent'   { $absent++ }
            default    { $attention++ }
        }
    }
    $sep = " " + (Get-Tinted $script:Style.Sep $script:Style.Dim) + " "
    $summary = Get-Tinted "$linked linked" $script:Style.Green
    if ($attention -gt 0) { $summary += $sep + (Get-Tinted "$attention need attention" $script:Style.Yellow) }
    if ($unlinked -gt 0) { $summary += $sep + "$unlinked unlinked" }
    if ($absent -gt 0) { $summary += $sep + (Get-Tinted "$absent not installed" $script:Style.Dim) }
    Write-Line "  $summary"
    return $linked
}

# ---------- build ----------

$script:Built = $false

function Invoke-BuildOnce {
    if (-not $Opt.Build) {
        if (-not (Test-Path -LiteralPath (Join-Path $RepoDir 'dist/extension.js'))) {
            Write-Step ((Get-Tinted 'warning' $script:Style.Yellow) + ': dist/extension.js is missing; the editor cannot activate this extension.')
        }
        return $true
    }
    if ($script:Built) { return $true }
    if ($Opt.DryRun) {
        Write-Step "would run: npm run build  (in $RepoDir)"
        $script:Built = $true
        return $true
    }
    Write-Step 'building...'
    Push-Location $RepoDir
    try {
        $npm = Get-PreferredCommand 'npm'
        if (-not $npm) {
            Write-Step ((Get-Tinted 'error' $script:Style.Red) + ': npm not found on PATH')
            return $false
        }
        & $npm.Source 'run' 'build' *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Step ((Get-Tinted 'error' $script:Style.Red) + ": build failed - run 'npm run build' to see why")
            return $false
        }
    } finally {
        Pop-Location
    }
    $script:Built = $true
    Write-Step 'dist/ built'
    return $true
}

# ---------- link / unlink ----------

# Delete a link without ever following it into the repository.
function Remove-LinkOnly([string] $path) {
    if ($Opt.DryRun) { Write-Step "would remove: $path"; return }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer) {
        [System.IO.Directory]::Delete($item.FullName, $false)
    } else {
        [System.IO.File]::Delete($item.FullName)
    }
}

function Remove-RealDirectory([string] $path) {
    if ($Opt.DryRun) { Write-Step "would remove tree: $path"; return }
    Remove-Item -LiteralPath $path -Recurse -Force
}

function New-ExtensionLink([string] $link) {
    if ($Opt.DryRun) {
        Write-Step "would link: $link $($script:Style.Arrow) $RepoDir"
        return $true
    }
    $kinds = @('SymbolicLink', 'Junction')
    if ($Opt.Junction) { $kinds = @('Junction') }
    $lastError = ''
    foreach ($kind in $kinds) {
        try {
            New-Item -ItemType $kind -Path $link -Target $RepoDir -ErrorAction Stop | Out-Null
            $label = 'linked'
            if ($kind -eq 'Junction') { $label = 'linked (junction)' }
            Write-Step ((Get-Tinted "$($script:Style.Ok) $label" $script:Style.Green) +
                        " $LinkName $($script:Style.Arrow) " + (Get-Tinted (Get-AbbreviatedPath $RepoDir) $script:Style.Dim))
            return $true
        } catch {
            $lastError = $_.Exception.Message
            if ($kind -eq 'SymbolicLink' -and $kinds.Count -gt 1) {
                Write-Step (Get-Tinted "symlink not permitted here - falling back to a junction" $script:Style.Dim)
            }
        }
    }
    Write-Step ((Get-Tinted 'error' $script:Style.Red) + ": could not create a link at $link")
    Write-Step "       $lastError"
    Write-Step '       Enable Developer Mode (Settings > For developers), run as Administrator,'
    Write-Step '       or pass --junction.'
    return $false
}

# Remove our links (any version) plus broken links for this id. Never real dirs.
function Remove-OurLinks([string] $dir, [string] $keep = '') {
    $removed = 0
    foreach ($entry in Get-DirEntries $dir) {
        if ($keep -and ($entry.Base -ieq $keep)) { continue }
        switch ($entry.State) {
            'broken' { Remove-LinkOnly $entry.Full; Write-Step "removed broken link $($entry.Base)"; $removed++ }
            'linked' { Remove-LinkOnly $entry.Full; Write-Step "removed link $($entry.Base)"; $removed++ }
            'stale'  { Remove-LinkOnly $entry.Full; Write-Step "removed link $($entry.Base)"; $removed++ }
            'other'  { Write-Step "left alone $($entry.Base) $($script:Style.Arrow) $($entry.Detail)" }
            'copy'   { if (-not $keep) { Write-Step "left alone $($entry.Base) (real directory, not ours to delete)" } }
        }
    }
    if ($removed -eq 0 -and -not $keep) { Write-Step 'nothing to remove' }
}

function Test-CliSees([string] $cli, [string] $dir) {
    if (-not $cli -or $Opt.DryRun) { return }
    $cmd = Get-PreferredCommand $cli
    if (-not $cmd) { return }
    try {
        $listed = & $cmd.Source '--list-extensions' '--extensions-dir' $dir 2>$null
        if ($listed -and ($listed -contains $ExtId)) {
            Write-Step ((Get-Tinted 'verified' $script:Style.Green) + ": $cli sees $ExtId in this directory")
        } else {
            Write-Step ((Get-Tinted 'note' $script:Style.Yellow) + ": $cli does not list it yet - restart the editor")
        }
    } catch { }
}

function Invoke-LinkTarget([string] $dir, [string] $cli) {
    $link = Join-Path $dir $LinkName

    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        if ($Opt.CreateDir) {
            if ($Opt.DryRun) { Write-Step "would create: $dir" }
            else { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Write-Step 'created directory'
        } else {
            Write-Step ((Get-Tinted 'skipped' $script:Style.Dim) + ': directory does not exist (pass --create-dir to create it)')
            return $false
        }
    }

    if (-not (Invoke-BuildOnce)) { return $false }

    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if (Test-IsLink $item) {
            if (Test-PointsAtRepo $item) {
                Write-Step ((Get-Tinted "$($script:Style.Ok) already linked" $script:Style.Green) + " $($script:Style.Arrow) this repo")
            } else {
                Write-Step "replacing existing link ($($script:Style.Arrow) $(Get-LinkTargetPath $item))"
                Remove-LinkOnly $link
                if (-not (New-ExtensionLink $link)) { return $false }
            }
        } else {
            if ($Opt.Force) {
                Write-Step "removing real directory (--force): $link"
                Remove-RealDirectory $link
                if (-not (New-ExtensionLink $link)) { return $false }
            } else {
                Write-Step ((Get-Tinted 'refused' $script:Style.Yellow) + ": $link exists as a real directory (an installed copy?).")
                Write-Step '         Inspect it, then re-run with --force to replace it.'
                return $false
            }
        }
    } else {
        if (-not (New-ExtensionLink $link)) { return $false }
    }

    Remove-OurLinks $dir $LinkName
    Test-CliSees $cli $dir
    return $true
}

function Invoke-UnlinkTarget([string] $dir) {
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        Write-Step ((Get-Tinted 'skipped' $script:Style.Dim) + ': directory does not exist')
        return
    }
    Remove-OurLinks $dir
}

# ---------- sentry-cli health / token advisory ----------
#
# Advisory only: the extension talks to Sentry itself and keeps its own token in
# SecretStorage or .sentry_viewer/local.json. sentry-cli is a convenience - it is
# where the extension's one-time token import reads from, and what uploads
# sourcemaps so production stack frames resolve to real files. Nothing here can
# fail a link.

# All resolutions for a command name, real executables first.
#
# On Windows, npm installs three shims per binary (foo, foo.cmd, foo.ps1) and
# Get-Command returns the .ps1 first. Invoking that shim from inside another
# script gives unreliable stdout/$LASTEXITCODE, which made a perfectly healthy
# sentry-cli report as broken. Prefer the Application (.cmd/.exe) form.
function Get-CommandCandidates([string] $name) {
    $all = @(Get-Command $name -All -ErrorAction SilentlyContinue)
    $ordered = New-Object System.Collections.ArrayList
    foreach ($type in @('Application', 'ExternalScript')) {
        foreach ($candidate in $all) {
            if ($candidate.CommandType -eq $type) { [void]$ordered.Add($candidate) }
        }
    }
    foreach ($candidate in $all) {
        if (-not ($ordered -contains $candidate)) { [void]$ordered.Add($candidate) }
    }
    return $ordered
}

function Get-PreferredCommand([string] $name) {
    $candidates = Get-CommandCandidates $name
    if ($candidates.Count -gt 0) { return $candidates[0] }
    return $null
}

# Run "<cmd> --version" and return the first non-empty output line, or ''.
# Deliberately avoids a pipeline so shims cannot be cancelled mid-run, and
# treats version-looking output as success even if the shim leaves a stale
# exit code behind.
function Get-CommandVersionText($candidate) {
    try {
        $global:LASTEXITCODE = 0
        $raw = & $candidate.Source '--version' 2>$null
        $code = $LASTEXITCODE
        $text = ''
        foreach ($line in @($raw)) {
            $trimmed = ([string]$line).Trim()
            if ($trimmed) { $text = $trimmed; break }
        }
        if ($text -and ($code -eq 0 -or $text -match '\d+\.\d+')) { return $text }
    } catch { }
    return ''
}

# Resolved sentry-cli plus its health, trying every resolution before giving up.
# Tried holds each resolution attempted, so an unhealthy result can say why.
function Get-SentryCliInfo {
    $candidates = Get-CommandCandidates 'sentry-cli'
    if ($candidates.Count -eq 0) { return $null }
    $tried = New-Object System.Collections.ArrayList
    foreach ($candidate in $candidates) {
        # Annotate only the interesting case: a shim rather than a real
        # executable, which is what goes wrong with npm's .ps1 wrappers.
        if ($candidate.CommandType -eq 'Application') {
            [void]$tried.Add([string]$candidate.Source)
        } else {
            [void]$tried.Add("$($candidate.Source) ($($candidate.CommandType))")
        }
        $version = Get-CommandVersionText $candidate
        if ($version) {
            return [pscustomobject]@{ Source = $candidate.Source; Version = $version; Healthy = $true; Tried = $tried }
        }
    }
    return [pscustomobject]@{ Source = $candidates[0].Source; Version = ''; Healthy = $false; Tried = $tried }
}

# Where a sentry-cli token lives. Never returns the token itself.
function Get-SentryTokenSource {
    if ($env:SENTRY_AUTH_TOKEN) { return 'SENTRY_AUTH_TOKEN environment variable' }
    $candidates = New-Object System.Collections.ArrayList
    [void]$candidates.Add((Join-Path (Get-Location).Path '.sentryclirc'))
    foreach ($root in Get-HomeRoots) { [void]$candidates.Add((Join-Path $root '.sentryclirc')) }
    foreach ($file in $candidates) {
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            try {
                foreach ($line in (Get-Content -LiteralPath $file -ErrorAction Stop)) {
                    if ($line -match '^\s*token\s*=\s*\S') { return (Get-AbbreviatedPath $file) }
                }
            } catch { }
        }
    }
    return ''
}

function Get-CliInstallOptions {
    $options = New-Object System.Collections.ArrayList
    # npm first: this repo already needs Node, so it always applies.
    [void]$options.Add([pscustomobject]@{ Label = 'npm install -g @sentry/cli'; Exe = 'npm'; Args = @('install', '-g', '@sentry/cli') })
    switch (Get-PlatformKind) {
        'windows' {
            if (Get-Command scoop -ErrorAction SilentlyContinue) {
                [void]$options.Add([pscustomobject]@{ Label = 'scoop install sentry-cli'; Exe = 'scoop'; Args = @('install', 'sentry-cli') })
            }
        }
        'macos' {
            if (Get-Command brew -ErrorAction SilentlyContinue) {
                [void]$options.Add([pscustomobject]@{ Label = 'brew install getsentry/tools/sentry-cli'; Exe = 'brew'; Args = @('install', 'getsentry/tools/sentry-cli') })
            }
            [void]$options.Add([pscustomobject]@{ Label = 'curl -sL https://sentry.io/get-cli/ | sh'; Exe = 'sh'; Args = @('-c', 'curl -sL https://sentry.io/get-cli/ | sh') })
        }
        default {
            [void]$options.Add([pscustomobject]@{ Label = 'curl -sL https://sentry.io/get-cli/ | sh'; Exe = 'sh'; Args = @('-c', 'curl -sL https://sentry.io/get-cli/ | sh') })
        }
    }
    return $options
}

function Invoke-CliInstallOffer {
    $options = Get-CliInstallOptions
    Write-Step 'install with:'
    $n = 1
    foreach ($option in $options) {
        Write-Step ("  " + (Get-Tinted "$n)" $script:Style.Cyan) + " " + $option.Label)
        $n++
    }

    if ($Opt.DryRun) {
        Write-Step (Get-Tinted 'dry-run: not offering to install' $script:Style.Dim)
        return
    }
    if (-not (Test-Interactive)) {
        Write-Step (Get-Tinted 'run one of the above, then re-run this command' $script:Style.Dim)
        return
    }

    $total = $options.Count
    $answer = Read-Answer "  Install now? [1-$total, or N to skip] $($script:Style.Prompt) "
    if ($answer -in @('', 'n', 'N', 'no', 'q', 'Q')) {
        Write-Step (Get-Tinted 'skipped' $script:Style.Dim)
        return
    }
    if ($answer -notmatch '^\d+$') {
        Write-Step (Get-Tinted "not a choice: $answer" $script:Style.Yellow)
        return
    }
    $index = [int]$answer
    if ($index -lt 1 -or $index -gt $total) {
        Write-Step (Get-Tinted "out of range: $answer" $script:Style.Yellow)
        return
    }

    $chosen = $options[$index - 1]
    Write-Line ''
    Write-Step "running: $($chosen.Label)"
    Write-Line ''
    $exe = Get-PreferredCommand $chosen.Exe
    if (-not $exe) {
        Write-Step ((Get-Tinted 'error' $script:Style.Red) + ": $($chosen.Exe) is not on PATH")
        return
    }
    $global:LASTEXITCODE = 0
    & $exe.Source @($chosen.Args)
    $code = $LASTEXITCODE
    Write-Line ''
    if ($code -eq 0) {
        $found = Get-SentryCliInfo
        if ($found) {
            $version = $found.Version
            if (-not $version) { $version = 'sentry-cli' }
            Write-Step ((Get-Tinted "$($script:Style.Ok) installed" $script:Style.Green) + " $version")
        } else {
            Write-Step ((Get-Tinted 'note' $script:Style.Yellow) + ': install reported success but sentry-cli is not on PATH yet.')
            Write-Step '       Open a new terminal, or add the global bin directory to PATH.'
        }
    } else {
        Write-Step ((Get-Tinted 'install failed' $script:Style.Yellow) + ' - try another option above.')
        if ($chosen.Exe -eq 'npm') {
            Write-Step '       A global npm install may need elevation, or set a user prefix:'
            Write-Step '         npm config set prefix ~/.local ; npm install -g @sentry/cli'
        }
    }
}

# Returns the number of problems found (0 = healthy CLI and a token on file).
# Link paths discard the value; the standalone --cli-check action propagates it.
function Test-SentryCli {
    if (-not $Opt.CliCheck) { return 0 }
    $issues = 0
    Write-Line ''
    Write-Line ("  " + (Get-Tinted 'Sentry CLI' $script:Style.Bold) + " " +
                (Get-Tinted '(optional - token import and sourcemap uploads)' $script:Style.Dim))

    $cli = Get-SentryCliInfo
    if ($cli) {
        if ($cli.Healthy) {
            Write-Step ((Get-Tinted $script:Style.Ok $script:Style.Green) + " $($cli.Version)  " + (Get-Tinted $cli.Source $script:Style.Dim))
        } else {
            Write-Step ((Get-Tinted $script:Style.Warn $script:Style.Yellow) +
                        " installed but 'sentry-cli --version' printed no version - it looks broken")
            foreach ($attempt in $cli.Tried) {
                Write-Step (Get-Tinted "       tried: $attempt" $script:Style.Dim)
            }
            Write-Step (Get-Tinted '       run that command yourself to see the error' $script:Style.Dim)
            $issues++
        }
    } else {
        Write-Step (Get-Tinted "$($script:Style.Warn) not installed" $script:Style.Yellow)
        Invoke-CliInstallOffer
        $cli = Get-SentryCliInfo
        if (-not $cli) { $issues++ }
    }

    $source = Get-SentryTokenSource
    if ($source) {
        Write-Step ((Get-Tinted $script:Style.Ok $script:Style.Green) + " auth token on file " + (Get-Tinted "($source)" $script:Style.Dim))
        Write-Step (Get-Tinted 'the extension can import it on first run: Sentry: Sign In' $script:Style.Dim)
    } else {
        Write-Step (Get-Tinted "$($script:Style.Warn) no auth token on file" $script:Style.Yellow)
        $tokenUrl = Get-Tinted 'https://sentry.io/settings/account/api/auth-tokens/' $script:Style.Cyan
        if ($cli) {
            Write-Step "       Create one at $tokenUrl then run:"
            Write-Step '         sentry-cli login'
        } else {
            Write-Step "       Create one at $tokenUrl"
        }
        Write-Step (Get-Tinted 'or paste one straight into the extension: Sentry: Sign In' $script:Style.Dim)
        $issues++
    }
    return $issues
}

# ---------- interactive menu ----------

function Test-Interactive {
    if ($Opt.Interactive -eq 'never') { return $false }
    try {
        if ([Console]::IsInputRedirected -and [Console]::IsOutputRedirected) { return $false }
        if ([Console]::IsOutputRedirected) { return $false }
    } catch { return $false }
    if (-not [Environment]::UserInteractive) { return $false }
    return $true
}

function Read-Answer([string] $prompt) {
    Write-Host $prompt -NoNewline
    try {
        $line = [Console]::ReadLine()
    } catch {
        $line = $null
    }
    if ($null -eq $line) { Write-Line ''; return 'q' }
    return $line.Trim()
}

function Invoke-Menu {
    while ($true) {
        $rows = Get-Rows
        $total = $rows.Count
        Write-Header
        Write-Table $rows $true
        Write-Notes $rows
        Write-Line ''
        [void](Write-Summary $rows)
        Write-Line ''
        if ($Opt.DryRun) { Write-Line ("  " + (Get-Tinted 'dry-run: no changes will be written' $script:Style.Yellow)) }

        $sep = Get-Tinted $script:Style.Sep $script:Style.Dim
        $answer = Read-Answer ("  Row to change [1-$total] $sep (c)heck sentry-cli $sep (r)efresh $sep (q)uit $($script:Style.Prompt) ")

        if ($answer -in @('q', 'Q', 'quit', 'exit')) { Write-Line ''; return 0 }
        if ($answer -in @('c', 'C', 'check')) {
            $Opt.CliCheck = $true
            [void](Test-SentryCli)
            continue
        }
        if ($answer -in @('', 'r', 'R', 'refresh')) { continue }
        if ($answer -notmatch '^\d+$') {
            Write-Line ''
            Write-Line ("  " + (Get-Tinted "Not a row number: $answer" $script:Style.Yellow))
            continue
        }
        $index = [int]$answer
        if ($index -lt 1 -or $index -gt $total) {
            Write-Line ''
            Write-Line ("  " + (Get-Tinted "Row $index is out of range (1-$total)" $script:Style.Yellow))
            continue
        }

        $row = $rows[$index - 1]
        Write-Line ''
        Write-Line ("  " + (Get-Tinted $row.Label $script:Style.Bold) + "  " + (Get-Tinted (Get-AbbreviatedPath $row.Dir) $script:Style.Dim))
        $style = Get-StatusStyle $row.Status
        Write-Line ("  status: " + (Get-Tinted "$($style.Glyph) $($row.Status)" $style.Color))
        foreach ($entry in Get-DirEntries $row.Dir) {
            Write-Line ("          " + (Get-Tinted "$($entry.State): $($entry.Base) $($script:Style.Arrow) $($entry.Detail)" $script:Style.Dim))
        }

        switch ($row.Status) {
            'linked'   { $hint = 'relink (already linked)' }
            'stale'    { $hint = 'link current version, remove the older link' }
            'copy'     { $hint = Get-Tinted 'replaces the installed copy' $script:Style.Yellow }
            'other'    { $hint = 'replace the foreign link' }
            'absent'   { $hint = 'create the directory, then link' }
            default    { $hint = 'link this repo here' }
        }

        Write-Line ''
        $choice = Read-Answer ("  (l)ink " + (Get-Tinted "- $hint" $script:Style.Dim) + " $sep (u)nlink $sep (b)ack $($script:Style.Prompt) ")
        Write-Line ''

        if ($choice -in @('l', 'L', 'link')) {
            # Confirmations apply to this action only; the saved values are
            # restored so a "yes" can never carry over to a later row.
            $savedForce = $Opt.Force
            $savedCreate = $Opt.CreateDir
            $proceed = $true
            if ($row.Status -eq 'copy') {
                Write-Line ("  " + (Get-Tinted "$($script:Style.Warn) $(Join-Path $row.Dir $LinkName) is a real directory, not a link." $script:Style.Yellow))
                Write-Line ("  " + (Get-Tinted '  Linking will delete it. If an editor installed it, it can be reinstalled.' $script:Style.Dim))
                $confirm = Read-Answer "  Delete it and link? [y/N] $($script:Style.Prompt) "
                if ($confirm -in @('y', 'Y', 'yes')) { $Opt.Force = $true } else { $proceed = $false }
                Write-Line ''
            }
            if ($proceed -and -not (Test-Path -LiteralPath $row.Dir -PathType Container)) {
                $confirm = Read-Answer "  Directory does not exist. Create it? [y/N] $($script:Style.Prompt) "
                if ($confirm -in @('y', 'Y', 'yes')) { $Opt.CreateDir = $true } else { $proceed = $false }
                Write-Line ''
            }
            if ($proceed) {
                Write-Line ("  " + (Get-Tinted $row.Label $script:Style.Bold))
                if (Invoke-LinkTarget $row.Dir $row.Cli) { [void](Test-SentryCli) }
            } else {
                Write-Line ("  " + (Get-Tinted 'cancelled' $script:Style.Dim))
            }
            $Opt.Force = $savedForce
            $Opt.CreateDir = $savedCreate
        } elseif ($choice -in @('u', 'U', 'unlink')) {
            Write-Line ("  " + (Get-Tinted $row.Label $script:Style.Bold))
            Invoke-UnlinkTarget $row.Dir
        } elseif ($choice -in @('b', 'B', 'back', '')) {
            Write-Line ("  " + (Get-Tinted 'back' $script:Style.Dim))
        } elseif ($choice -in @('q', 'Q', 'quit', 'exit')) {
            Write-Line ''
            return 0
        } else {
            Write-Line ("  " + (Get-Tinted "Unknown choice: $choice" $script:Style.Yellow))
        }
    }
}

# ---------- main ----------

if ($Opt.Action -eq 'clicheck') {
    $Opt.CliCheck = $true    # this action *is* the check, so --no-cli-check cannot mute it
    Write-Header
    $issues = Test-SentryCli
    Write-Line ''
    exit $issues
}

if ($Opt.Action -eq 'list') {
    if (Test-Interactive) {
        exit (Invoke-Menu)
    }
    $rows = Get-Rows
    Write-Header
    Write-Table $rows $false
    Write-Notes $rows
    Write-Line ''
    $linked = Write-Summary $rows
    if ($linked -eq 0) {
        Write-Line ("  " + (Get-Tinted 'Run' $script:Style.Dim) + " " + (Get-Tinted 'npm run link' $script:Style.Cyan) + " " +
                    (Get-Tinted 'to symlink this repo into the editors found above.' $script:Style.Dim))
    }
    Write-Line ''
    exit 0
}

# Batch install / uninstall
$targets = New-Object System.Collections.ArrayList
function Add-Target([string] $dir, [string] $label, [string] $cli) {
    $normalized = $dir.TrimEnd('\', '/')
    foreach ($existing in $targets) {
        if ($existing.Dir -ieq $normalized) { return }
    }
    [void]$targets.Add([pscustomobject]@{ Dir = $normalized; Label = $label; Cli = $cli })
}

foreach ($editor in $Opt.Editors) {
    $info = Get-EditorDir $editor
    Add-Target $info.Dir (Get-EditorLabel $editor) (Get-EditorCli $editor)
}
foreach ($p in $Opt.Paths) {
    $full = $p
    try { $full = [System.IO.Path]::GetFullPath($p) } catch { }
    Add-Target $full 'Custom path' ''
}
if ($targets.Count -eq 0 -or $Opt.Detected) {
    foreach ($editor in $AllEditors) {
        $info = Get-EditorDir $editor
        if ($info.Exists) { Add-Target $info.Dir (Get-EditorLabel $editor) (Get-EditorCli $editor) }
    }
}
if ($targets.Count -eq 0) {
    Write-Host 'error: no editor extension directories found.'
    Write-Host '       Use --path DIR, or a target flag together with --create-dir.'
    exit 1
}

$failures = 0
Write-Line ''
foreach ($target in $targets) {
    Write-Line ((Get-Tinted $target.Label $script:Style.Bold) + "  " + (Get-Tinted (Get-AbbreviatedPath $target.Dir) $script:Style.Dim))
    if ($Opt.Action -eq 'uninstall') {
        Invoke-UnlinkTarget $target.Dir
    } else {
        if (-not (Invoke-LinkTarget $target.Dir $target.Cli)) { $failures++ }
    }
    Write-Line ''
}

if ($Opt.Action -eq 'uninstall') {
    Write-Line 'Done. Reload or restart your editor to drop the extension.'
} else {
    if ($failures -lt $targets.Count) { [void](Test-SentryCli) }
    Write-Line ''
    Write-Line "Done. Run 'Developer: Reload Window' in each editor to load the current build."
    Write-Line "Tip: 'npm run watch' + reload gives a fast edit/test loop."
}

if ($failures -gt 0) { exit 1 }
exit 0
