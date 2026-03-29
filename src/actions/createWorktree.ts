import * as vscode from 'vscode';
import * as path from 'path';
import { TowerStateManager } from '../state/TowerStateManager';
import { exec, shellQuote } from '../util/exec';
import { openInVSCode } from '../util/vscodeCli';
import { getMainBranchName } from '../util/gitHelpers';
import { copyConfiguredFiles } from './hooksRunner';
import { getConfig } from '../util/configLoader';

/**
 * Create a new git worktree and open it in a new VS Code window.
 * Minimal flow: pick project (if needed) -> enter branch name -> done.
 */
export async function createWorktree(
  stateManager: TowerStateManager,
  projectArg?: any,
): Promise<void> {
  let projectPath: string | undefined;

  // Resolve project from arg (inline action on ProjectItem passes the item)
  if (projectArg && typeof projectArg === 'object' && 'project' in projectArg) {
    projectPath = projectArg.project.path;
  }

  // No project from arg — show picker
  if (!projectPath) {
    const projects = stateManager.getProjects();
    if (projects.length === 0) {
      vscode.window.showWarningMessage('No projects found.');
      return;
    }
    if (projects.length === 1) {
      projectPath = projects[0].path;
    } else {
      const picked = await vscode.window.showQuickPick(
        projects.map((p) => ({ label: p.name, detail: p.path, path: p.path })),
        { placeHolder: 'Select project', title: 'New Worktree' },
      );
      if (!picked) { return; }
      projectPath = picked.path;
    }
  }

  const branch = await vscode.window.showInputBox({
    prompt: 'Branch name for new worktree',
    placeHolder: 'feature/my-feature',
    validateInput: (value) => {
      if (!value.trim()) { return 'Branch name is required'; }
      if (!/^[a-zA-Z0-9/._-]+$/.test(value)) {
        return 'Branch name can only contain letters, numbers, slashes, dots, and hyphens';
      }
      return undefined;
    },
  });
  if (!branch) { return; }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Creating worktree: ${branch}`,
    },
    async (progress) => {
      const config = getConfig(projectPath!);
      const worktreeDir =
        config?.worktreeDir ||
        path.join(path.dirname(projectPath!), '.worktrees');
      const worktreePath = path.join(worktreeDir, branch.replace(/\//g, '-'));
      const mainBranch = await getMainBranchName(projectPath!);

      // Fetch latest from remote before branching
      await exec(`git fetch origin ${shellQuote(mainBranch)}`, { cwd: projectPath! }).catch(() => {});

      await exec(
        `git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreePath)} origin/${shellQuote(mainBranch)}`,
        { cwd: projectPath! },
      );

      progress.report({ message: 'Copying files...' });
      await copyConfiguredFiles(projectPath!, worktreePath, config, progress);

      progress.report({ message: 'Opening VS Code...' });
      await openInVSCode(worktreePath, true);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Start a new Claude Code session in the new worktree
      const uri = vscode.Uri.parse('vscode://anthropic.claude-code/open');
      await vscode.env.openExternal(uri);

      // Track as pending worktree until a session appears
      stateManager.addPendingWorktree(worktreePath, branch);

      await stateManager.refresh();
    },
  );
}
