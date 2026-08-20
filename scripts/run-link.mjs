#!/usr/bin/env node
/**
 * Cross-platform dispatcher for the extension linker.
 *
 * npm runs package scripts through cmd.exe on Windows, where `bash` may not
 * exist, /dev/tty reads fail, and `ln -s` needs privileges. So Windows gets the
 * native PowerShell implementation and everything else gets the shell one.
 * Both accept the same `--flag` arguments, so `npm run link -- --cursor`
 * behaves identically on every platform.
 *
 * Override the choice with SENTRY_LINK_IMPL=ps|sh (e.g. to use the shell
 * version from Git Bash on Windows).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const shPath = join(scriptDir, 'install-link.sh');
const psPath = join(scriptDir, 'install-link.ps1');
const args = process.argv.slice(2);

/** First command that runs, so we can prefer PowerShell 7 over 5.1. */
function firstWorking(candidates, probeArgs) {
  for (const cmd of candidates) {
    const probe = spawnSync(cmd, probeArgs, { stdio: 'ignore', shell: false });
    if (!probe.error) return cmd;
  }
  return undefined;
}

function runPowerShell() {
  const shell = firstWorking(['pwsh', 'powershell'], ['-NoProfile', '-Command', 'exit 0']);
  if (!shell) {
    console.error(
      'error: PowerShell not found. Install PowerShell 7 (https://aka.ms/powershell),\n' +
        '       or set SENTRY_LINK_IMPL=sh to use scripts/install-link.sh from Git Bash.',
    );
    return 1;
  }
  const result = spawnSync(
    shell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, ...args],
    { stdio: 'inherit', shell: false },
  );
  return result.status === null ? 1 : result.status;
}

function runShell() {
  const bash = firstWorking(['bash'], ['-c', 'exit 0']);
  if (!bash) {
    console.error(
      'error: bash not found.' +
        (process.platform === 'win32'
          ? ' On Windows, unset SENTRY_LINK_IMPL to use the PowerShell version.'
          : ' Install bash, or run the script with sh-compatible bash 3.2+.'),
    );
    return 1;
  }
  const result = spawnSync(bash, [shPath, ...args], { stdio: 'inherit', shell: false });
  return result.status === null ? 1 : result.status;
}

const override = (process.env.SENTRY_LINK_IMPL || '').toLowerCase();
let impl;
if (override === 'ps' || override === 'powershell') impl = 'ps';
else if (override === 'sh' || override === 'bash') impl = 'sh';
else impl = process.platform === 'win32' ? 'ps' : 'sh';

const wanted = impl === 'ps' ? psPath : shPath;
if (!existsSync(wanted)) {
  console.error(`error: missing ${wanted}`);
  process.exit(1);
}

process.exit(impl === 'ps' ? runPowerShell() : runShell());
