import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

function redact(text: string): string {
  return text.replace(/(Bearer\s+)\S+/gi, '$1<redacted>').replace(/(sntrys_)\S+/g, '$1<redacted>');
}

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Sentry');
  context.subscriptions.push(channel);
}

export function log(message: string, ...details: unknown[]): void {
  const extra = details.length ? ' ' + details.map((d) => redact(String(d))).join(' ') : '';
  channel?.appendLine(`[${new Date().toISOString()}] ${redact(message)}${extra}`);
}
