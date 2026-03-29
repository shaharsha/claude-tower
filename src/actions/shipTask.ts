import * as vscode from 'vscode';
import type { TowerTask } from '../types';
import { TowerStateManager } from '../state/TowerStateManager';
import { exec, shellQuote } from '../util/exec';
import { focusVSCodeWindow } from '../util/vscodeCli';
import { getConfig } from '../util/configLoader';

/**
 * Ship a task: either let Claude commit and create a PR,
 * or do a quick ship (git add, commit, push, gh pr create).
 */
export async function shipTask(
  task: TowerTask,
  stateManager: TowerStateManager,
  linearService?: any,
): Promise<void> {
  // Check gh CLI is installed
  try {
    await exec('which gh', { timeout: 5000 });
  } catch {
    vscode.window.showErrorMessage(
      'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/',
    );
    return;
  }

  const shipMode = await vscode.window.showQuickPick(
    [
      {
        label: '$(hubot) Let Claude commit & create PR',
        description: 'Claude will handle the commit message and PR creation',
        value: 'claude' as const,
      },
      {
        label: '$(rocket) Quick ship',
        description: 'Auto-commit, push, and create PR immediately',
        value: 'quick' as const,
      },
    ],
    {
      placeHolder: 'How do you want to ship this task?',
      title: `Ship: ${task.title}`,
    },
  );

  if (!shipMode) {
    return;
  }

  const cwd = task.worktreePath || task.projectPath;
  if (!cwd) {
    vscode.window.showErrorMessage('No working directory found for this task.');
    return;
  }

  const config = getConfig(task.projectPath);
  const baseBranch = config?.pr?.baseBranch || 'main';
  const isDraft = config?.pr?.draft ?? false;

  if (shipMode.value === 'claude') {
    const parts: string[] = [
      `Ship this task to a pull request.`,
      '',
      'Steps:',
      '1. Review all changes on this branch',
      '2. Stage and commit with a clear, descriptive commit message',
    ];

    if (task.linearIssueId) {
      parts.push(`   - Prefix the commit message with "${task.linearIssueId}: "`);
    }

    parts.push(
      '3. Push the branch to origin',
      `4. Create a PR to the "${baseBranch}" branch using the gh CLI`,
      '   - Write a clear PR title and description explaining what changed and why',
    );

    if (task.linearIssueId) {
      parts.push(`   - Reference Linear ticket ${task.linearIssueId} (${task.linearIssueUrl || ''})`);
    }

    if (isDraft) {
      parts.push('   - Create as a draft PR');
    }

    parts.push('', 'Do not ask for confirmation. Just commit, push, and create the PR.');

    const prompt = parts.join('\n');

    // Focus the correct window
    if (task.worktreePath) {
      try {
        await focusVSCodeWindow(task.worktreePath);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch {
        // continue anyway
      }
    }

    // Send via URI handler
    const uri = vscode.Uri.parse(
      `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`,
    );
    await vscode.env.openExternal(uri);
  } else {
    // Quick ship mode
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Shipping: ${task.title}`,
        cancellable: false,
      },
      async (progress) => {
        // Check for uncommitted changes
        const status = await exec('git status --porcelain', { cwd, timeout: 10000 });
        if (status.trim()) {
          // git add -A
          progress.report({ message: 'Staging changes...' });
          await exec('git add -A', { cwd });

          // git commit
          progress.report({ message: 'Committing...' });
          const commitMsg = task.linearIssueId
            ? `${task.linearIssueId}: ${task.title}`
            : task.title;
          await exec(`git commit -m ${shellQuote(commitMsg)}`, {
            cwd,
          });
        }

        // git push -u origin
        progress.report({ message: 'Pushing...' });
        const branch = task.branch || (await getCurrentBranch(cwd));
        await exec(`git push -u origin ${shellQuote(branch)}`, { cwd });

        // Build PR description
        progress.report({ message: 'Creating PR...' });
        const prDescription = await buildPrDescription(task, cwd, baseBranch, branch);

        const draftFlag = isDraft ? '--draft' : '';
        const prTitle = task.linearIssueId
          ? `${task.linearIssueId}: ${task.title}`
          : task.title;

        const prOutput = await exec(
          `gh pr create --title ${shellQuote(prTitle)}` +
            ` --body ${shellQuote(prDescription)}` +
            ` --base ${shellQuote(baseBranch)} ${draftFlag}`.trim(),
          { cwd },
        );

        // Update Linear status
        if (linearService && task.linearIssueId) {
          try {
            await linearService.updateIssueStatus(task.linearIssueId, 'In Review');
          } catch {
            // non-critical
          }
        }

        // Update task status to done
        stateManager.updateTaskStatus(task.id, 'done');
        stateManager.markAsRead(task.id);

        const prUrl = prOutput.trim();
        if (prUrl) {
          const openAction = await vscode.window.showInformationMessage(
            `PR created for "${task.title}"`,
            'Open in GitHub',
          );
          if (openAction) {
            await exec('gh pr view --web', { cwd }).catch(() => {
              vscode.env.openExternal(vscode.Uri.parse(prUrl));
            });
          }
        }
      },
    );
  }
}

/**
 * Build a PR description with task title, Linear link, and diff stat.
 */
async function buildPrDescription(
  task: TowerTask,
  cwd: string,
  baseBranch: string,
  branch: string,
): Promise<string> {
  const parts: string[] = [];

  parts.push(`## ${task.title}`);
  parts.push('');

  if (task.linearIssueUrl) {
    parts.push(`Linear: ${task.linearIssueUrl}`);
    parts.push('');
  }

  if (task.description) {
    parts.push(task.description);
    parts.push('');
  }

  // Add diff stat
  try {
    const diffStat = await exec(
      `git diff --stat ${shellQuote(baseBranch)}...${shellQuote(branch)}`,
      { cwd, timeout: 10000 },
    );
    if (diffStat.trim()) {
      parts.push('### Changes');
      parts.push('```');
      parts.push(diffStat.trim());
      parts.push('```');
    }
  } catch {
    // ignore diff stat errors
  }

  parts.push('');
  parts.push('---');
  parts.push('*Created with [Claude Tower](https://github.com/shaharsha/claude-tower)*');

  return parts.join('\n');
}

/**
 * Get the current branch name for a working directory.
 */
async function getCurrentBranch(cwd: string): Promise<string> {
  const output = await exec('git rev-parse --abbrev-ref HEAD', {
    cwd,
    timeout: 5000,
  });
  return output.trim();
}
