import * as vscode from 'vscode';
import { openInVSCode, focusVSCodeWindow } from '../util/vscodeCli';

/**
 * Open a new Claude Code session for a worktree path.
 * Opens immediately — no prompt dialogs. The user types directly in Claude Code.
 */
export async function newSession(worktreePath: string): Promise<void> {
  const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (worktreePath !== currentWorkspace) {
    // Try to focus an existing window, fall back to opening a new one
    try {
      await focusVSCodeWindow(worktreePath);
    } catch {
      await openInVSCode(worktreePath, true);
    }
    // Give the window a moment to become ready
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  const uri = vscode.Uri.parse('vscode://anthropic.claude-code/open');
  await vscode.env.openExternal(uri);
}
