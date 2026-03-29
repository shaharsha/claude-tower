import * as vscode from 'vscode';
import type { TowerTask } from '../types';
import { TowerStateManager } from '../state/TowerStateManager';
import { exec, shellQuote } from '../util/exec';
import { runHook } from './hooksRunner';
import { getConfig } from '../util/configLoader';

/**
 * Archive a task: remove the worktree, optionally delete the branch,
 * optionally mark done in Linear, and mark the task as done in state.
 */
export async function archiveTask(
  task: TowerTask,
  stateManager: TowerStateManager,
  linearService?: any,
): Promise<void> {
  const options: string[] = ['Remove worktree only', 'Remove worktree + delete branch'];

  // Add Linear options if the task has a Linear issue and the service is available
  if (task.linearIssueId && linearService) {
    options.push('Remove + delete branch + mark Done in Linear');
  }

  const choice = await vscode.window.showWarningMessage(
    `Archive task "${task.title}"?`,
    { modal: true },
    ...options,
  );

  if (!choice) {
    return;
  }

  const deleteBranch = choice.includes('delete branch');
  const updateLinear = choice.includes('Done in Linear');

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Archiving: ${task.title}`,
      cancellable: false,
    },
    async (progress) => {
      const config = getConfig(task.projectPath);

      // Run preArchive hook
      progress.report({ message: 'Running preArchive hook...' });
      await runHook('preArchive', task, config, progress);

      // Remove worktree
      if (task.worktreePath && task.projectPath) {
        progress.report({ message: 'Removing worktree...' });
        try {
          await exec(`git worktree remove ${shellQuote(task.worktreePath)} --force`, {
            cwd: task.projectPath,
          });
        } catch (err) {
          vscode.window.showWarningMessage(
            `Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Delete branch if requested
      if (deleteBranch && task.branch && task.projectPath) {
        progress.report({ message: 'Deleting branch...' });
        try {
          await exec(`git branch -D ${shellQuote(task.branch)}`, {
            cwd: task.projectPath,
          });
        } catch (err) {
          vscode.window.showWarningMessage(
            `Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Update Linear if requested
      if (updateLinear && task.linearIssueId && linearService) {
        progress.report({ message: 'Updating Linear...' });
        try {
          await linearService.updateIssueStatus(task.linearIssueId, 'Done');
        } catch (err) {
          vscode.window.showWarningMessage(
            `Failed to update Linear: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Mark task as done in stateManager
      progress.report({ message: 'Updating task status...' });
      stateManager.updateTaskStatus(task.id, 'done');
    },
  );
}
