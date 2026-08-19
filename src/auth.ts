import * as vscode from 'vscode';
import { ConfigService } from './config/workspaceConfig';
import { log } from './util/log';

const SECRET_KEY = 'sentry.authToken';
const IMPORT_OFFERED_KEY = 'sentry.cliImportOffered';

export class AuthService {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: ConfigService,
  ) {}

  async getToken(): Promise<string | undefined> {
    const override = this.config.get().tokenOverride;
    if (override) return override;
    return this.context.secrets.get(SECRET_KEY);
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean(await this.getToken());
  }

  async updateContextKey(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'sentry.signedIn', await this.isSignedIn());
  }

  /**
   * Ensure a token exists, offering a one-time import from ~/.sentryclirc
   * before falling back to a manual paste.
   */
  async signIn(): Promise<boolean> {
    const cliToken = this.config.get().cliToken;
    const alreadyOffered = this.context.globalState.get<boolean>(IMPORT_OFFERED_KEY);
    if (cliToken && !alreadyOffered) {
      await this.context.globalState.update(IMPORT_OFFERED_KEY, true);
      const choice = await vscode.window.showInformationMessage(
        'A Sentry auth token was found in ~/.sentryclirc. Import it?',
        'Import',
        'Enter Manually',
      );
      if (choice === 'Import') {
        await this.setToken(cliToken);
        return true;
      }
      if (choice === undefined) return false;
    }
    const entered = await vscode.window.showInputBox({
      title: 'Sentry Auth Token',
      prompt: 'Paste a Sentry auth token (User Settings → Auth Tokens on sentry.io)',
      password: true,
      placeHolder: 'sntrys_… or legacy 64-char token',
      ignoreFocusOut: true,
    });
    if (!entered?.trim()) return false;
    await this.setToken(entered.trim());
    return true;
  }

  async importCliToken(): Promise<boolean> {
    const cliToken = this.config.get().cliToken;
    if (!cliToken) {
      void vscode.window.showWarningMessage('No token found in ~/.sentryclirc.');
      return false;
    }
    await this.setToken(cliToken);
    return true;
  }

  async setToken(token: string): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, token);
    await this.updateContextKey();
    log('Auth token stored in SecretStorage');
    this._onDidChange.fire();
  }

  async signOut(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    if (this.config.get().tokenOverride) {
      void vscode.window.showWarningMessage(
        'Signed out of the stored token, but a workspace token override in .sentry_viewer/local.json is still active.',
      );
    }
    await this.updateContextKey();
    this._onDidChange.fire();
  }
}
