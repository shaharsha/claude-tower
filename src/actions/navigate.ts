import * as vscode from 'vscode';
import type { TowerTask } from '../types';
import type { TowerStateManager } from '../state/TowerStateManager';
import { focusVSCodeWindow } from '../util/vscodeCli';

/**
 * Navigate to a task's active Claude Code session.
 * Marks the task as read, focuses the correct VS Code window (for worktree mode),
 * and opens the session via the Claude Code URI handler.
 */
export async function navigateToSession(
  task: TowerTask,
  context: vscode.ExtensionContext,
  stateManager?: TowerStateManager,
): Promise<void> {
  // Mark task as read via stateManager (updates in-memory + fires change event)
  if (stateManager) {
    stateManager.markAsRead(task.id);
  }
  // Also persist in globalState for cross-window tracking
  await context.globalState.update(`claude-tower.read.${task.id}`, Date.now());

  // If worktree mode and worktreePath exists, focus that VS Code window
  if (task.mode === 'worktree' && task.worktreePath) {
    try {
      await focusVSCodeWindow(task.worktreePath);
      // Wait 500ms for window focus
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (err) {
      console.warn('[claude-tower] Failed to focus worktree window:', err);
    }
  }

  // Open session via URI handler
  if (task.activeSessionId) {
    const uri = vscode.Uri.parse(
      `vscode://anthropic.claude-code/open?session=${encodeURIComponent(task.activeSessionId)}`,
    );
    await vscode.env.openExternal(uri);
  }

  // For review tasks with worktree mode, also open SCM view after 300ms
  if (task.status === 'review' && task.mode === 'worktree') {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vscode.commands.executeCommand('workbench.view.scm');
  }
}
