import * as vscode from 'vscode';

export class LinearAuth {
  private session: vscode.AuthenticationSession | undefined;

  /**
   * Initiate an OAuth session with Linear via the `linear.linear-connect` extension.
   * Returns true on success, false on failure.
   */
  async connect(): Promise<boolean> {
    try {
      this.session = await vscode.authentication.getSession(
        'linear',
        ['read', 'write'],
        { createIfNone: true },
      );
      return true;
    } catch {
      vscode.window
        .showInformationMessage(
          'Linear integration requires the Linear Connect extension.',
          'Install',
        )
        .then((action) => {
          if (action === 'Install') {
            vscode.commands.executeCommand(
              'workbench.extensions.installExtension',
              'linear.linear-connect',
            );
          }
        });
      return false;
    }
  }

  /**
   * Clear the stored session.
   */
  async disconnect(): Promise<void> {
    this.session = undefined;
  }

  isConnected(): boolean {
    return this.session !== undefined;
  }

  getAccessToken(): string {
    return this.session?.accessToken ?? '';
  }

  getAccountLabel(): string {
    return this.session?.account.label ?? '';
  }
}
