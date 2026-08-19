import * as vscode from 'vscode';
import { log } from '../util/log';
import type { IndexedFile } from './frameResolver';

const SOURCE_GLOB = '**/*.{vue,ts,tsx,js,jsx,mjs,cjs,svelte,py,rb,go,java,kt,cs,php}';
const EXCLUDE_GLOB = '**/{node_modules,dist,build,out,.git,.next,coverage}/**';

/** Lazily-built index of workspace source files for stack-frame suffix matching. */
export class WorkspaceIndex implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private files: IndexedFile[] | undefined;
  private building: Promise<IndexedFile[]> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB, false, true, false);
    watcher.onDidCreate((uri) => this.add(uri));
    watcher.onDidDelete((uri) => this.remove(uri));
    this.disposables.push(
      watcher,
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.files = undefined;
        this.building = undefined;
        this._onDidChange.fire();
      }),
    );
  }

  /** Current index; triggers a build on first call (returns [] until ready). */
  get(): IndexedFile[] {
    if (this.files) return this.files;
    void this.ensure();
    return [];
  }

  async ensure(): Promise<IndexedFile[]> {
    if (this.files) return this.files;
    if (!this.building) {
      this.building = this.build();
    }
    return this.building;
  }

  private async build(): Promise<IndexedFile[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      this.files = [];
      return this.files;
    }
    const started = Date.now();
    const uris = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB, 20000);
    this.files = uris.map((uri) => this.toIndexed(uri));
    log(`Workspace index built: ${this.files.length} files in ${Date.now() - started}ms`);
    this._onDidChange.fire();
    return this.files;
  }

  private toIndexed(uri: vscode.Uri): IndexedFile {
    const relative = vscode.workspace.asRelativePath(uri, false);
    return { fsPath: uri.fsPath, segments: relative.toLowerCase().split('/') };
  }

  private add(uri: vscode.Uri): void {
    if (!this.files) return;
    const fsPath = uri.fsPath;
    if (!this.files.some((f) => f.fsPath === fsPath)) {
      this.files.push(this.toIndexed(uri));
      this._onDidChange.fire();
    }
  }

  private remove(uri: vscode.Uri): void {
    if (!this.files) return;
    const before = this.files.length;
    this.files = this.files.filter((f) => f.fsPath !== uri.fsPath);
    if (this.files.length !== before) this._onDidChange.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this._onDidChange.dispose();
  }
}
