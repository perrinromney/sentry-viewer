import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const LOG_FILE_NAME = 'debug.log';
const ROTATE_AT_BYTES = 512 * 1024;
const EARLY_BUFFER_LINES = 300;

let channel: vscode.OutputChannel | undefined;
let filePath: string | undefined;
/** Serializes file appends so lines keep their order. */
let queue: Promise<void> = Promise.resolve();
/** Lines logged before a file target existed, flushed once one is set. */
let earlyBuffer: string[] = [];

function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/(sntrys_)\S+/g, '$1<redacted>')
    .replace(/("token"\s*:\s*")[^"]+(")/gi, '$1<redacted>$2');
}

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Sentry');
  context.subscriptions.push(channel);
}

async function ensureGitignore(dir: string): Promise<void> {
  const gitignorePath = path.join(dir, '.gitignore');
  const wanted = ['local.json', 'debug.log', 'debug.log.old'];
  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch {
    /* will create */
  }
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((w) => !lines.has(w));
  if (missing.length > 0) {
    await fs.writeFile(gitignorePath, (existing ? existing.replace(/\n?$/, '\n') : '') + missing.join('\n') + '\n');
  }
}

/**
 * Point file logging at a .sentry_viewer directory (or disable with
 * undefined). Rotates an oversized log, keeps the log gitignored, and
 * flushes lines that were logged before the target existed.
 */
export function setLogDirectory(dir: string | undefined): void {
  const target = dir ? path.join(dir, LOG_FILE_NAME) : undefined;
  if (target === filePath) return;
  filePath = target;
  if (!target || !dir) return;
  const buffered = earlyBuffer;
  earlyBuffer = [];
  queue = queue.then(async () => {
    try {
      await fs.mkdir(dir, { recursive: true });
      const stat = await fs.stat(target).catch(() => undefined);
      if (stat && stat.size > ROTATE_AT_BYTES) {
        await fs.rename(target, `${target}.old`).catch(() => {});
      }
      await ensureGitignore(dir);
      const header = `\n===== sentry-viewer session ${new Date().toISOString()} =====\n`;
      await fs.appendFile(target, header + (buffered.length ? buffered.join('\n') + '\n' : ''));
    } catch (e) {
      channel?.appendLine(`[log] file logging disabled: ${e}`);
      filePath = undefined;
    }
  });
}

export function getLogFile(): string | undefined {
  return filePath;
}

export async function clearLog(): Promise<void> {
  channel?.clear();
  earlyBuffer = [];
  const target = filePath;
  if (!target) return;
  await (queue = queue.then(() => fs.writeFile(target, `===== log cleared ${new Date().toISOString()} =====\n`).catch(() => {})));
}

/** Open the log file in an editor, falling back to the output channel. */
export async function showLog(): Promise<void> {
  if (filePath) {
    try {
      await queue;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    } catch {
      /* fall through to channel */
    }
  }
  channel?.show();
}

export function log(message: string, ...details: unknown[]): void {
  const extra = details.length ? ' ' + details.map((d) => redact(String(d))).join(' ') : '';
  const line = `[${new Date().toISOString()}] ${redact(message)}${extra}`;
  channel?.appendLine(line);
  if (filePath) {
    const target = filePath;
    queue = queue.then(() => fs.appendFile(target, line + '\n').catch(() => {}));
  } else {
    earlyBuffer.push(line);
    if (earlyBuffer.length > EARLY_BUFFER_LINES) earlyBuffer.shift();
  }
}
