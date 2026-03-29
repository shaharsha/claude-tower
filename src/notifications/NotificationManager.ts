import * as vscode from 'vscode';
import { TowerTask, TaskStatus } from '../types';

interface PendingTransition {
  task: TowerTask;
  from: TaskStatus;
  to: TaskStatus;
  timestamp: number;
}

export class NotificationManager {
  private previousStatuses: Map<string, TaskStatus> = new Map();
  private pendingTransitions: PendingTransition[] = [];
  private batchTimeout: NodeJS.Timeout | undefined;

  readonly BATCH_WINDOW_MS = 5000;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Compare old and new task lists, queue transitions for notification.
   */
  detectTransitions(oldTasks: TowerTask[], newTasks: TowerTask[]): void {
    // Build map of previous statuses from oldTasks (bootstrap on first call)
    if (this.previousStatuses.size === 0) {
      for (const t of oldTasks) {
        this.previousStatuses.set(t.id, t.status);
      }
    }

    for (const task of newTasks) {
      const prev = this.previousStatuses.get(task.id);
      if (prev && prev !== task.status) {
        this.pendingTransitions.push({
          task,
          from: prev,
          to: task.status,
          timestamp: Date.now(),
        });
      }
      this.previousStatuses.set(task.id, task.status);
    }

    // Remove entries for tasks that no longer exist
    const newIds = new Set(newTasks.map((t) => t.id));
    for (const id of this.previousStatuses.keys()) {
      if (!newIds.has(id)) {
        this.previousStatuses.delete(id);
      }
    }

    // Start (or restart) the batch window
    if (this.pendingTransitions.length > 0 && !this.batchTimeout) {
      this.batchTimeout = setTimeout(() => {
        this.flushTransitions();
      }, this.BATCH_WINDOW_MS);
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private flushTransitions(): void {
    this.batchTimeout = undefined;

    const transitions = this.pendingTransitions.splice(0);
    if (transitions.length === 0) {
      return;
    }

    // Filter by user configuration
    const config = vscode.workspace.getConfiguration('claude-tower.notifications');
    const filtered = transitions.filter((t) => {
      if (t.to === 'waiting' && config.get<boolean>('waiting', true)) {
        return true;
      }
      // "Task complete" fires when Claude finishes (in-progress/waiting -> review or done)
      if (
        (t.to === 'review' || t.to === 'done') &&
        (t.from === 'in-progress' || t.from === 'waiting') &&
        config.get<boolean>('done', true)
      ) {
        return true;
      }
      // Map session-level "error" concept: task going to any error-like state
      // We treat this via a config key; the caller should mark the task accordingly
      if (config.get<boolean>('error', true)) {
        // Check if any session on the task is in error state
        const hasError = t.task.sessions.some((s) => s.status === 'error');
        if (hasError && t.to !== 'waiting' && t.to !== 'done') {
          return true;
        }
      }
      return false;
    });

    if (filtered.length === 0) {
      return;
    }

    if (filtered.length === 1) {
      this.showIndividualToast(filtered[0]);
    } else {
      this.showBatchedToast(filtered);
    }
  }

  private showIndividualToast(transition: PendingTransition): void {
    const { task, from, to } = transition;
    const label = task.branch ?? task.title;
    const hasError = task.sessions.some((s) => s.status === 'error');

    if (to === 'waiting') {
      vscode.window
        .showWarningMessage(`${label} needs approval`, 'Go')
        .then((action) => {
          if (action === 'Go') {
            vscode.commands.executeCommand('claude-tower.goToTask', task);
          }
        });
    } else if (
      (to === 'review' || to === 'done') &&
      (from === 'in-progress' || from === 'waiting')
    ) {
      vscode.window
        .showInformationMessage(`Task complete: ${label}`, 'Review')
        .then((action) => {
          if (action === 'Review') {
            vscode.commands.executeCommand('claude-tower.reviewTask', task);
          }
        });
    } else if (hasError) {
      vscode.window
        .showErrorMessage(`Session errored: ${label}`, 'Check')
        .then((action) => {
          if (action === 'Check') {
            vscode.commands.executeCommand('claude-tower.goToTask', task);
          }
        });
    }
  }

  private showBatchedToast(transitions: PendingTransition[]): void {
    const waitingCount = transitions.filter((t) => t.to === 'waiting').length;
    const doneCount = transitions.filter((t) => t.to === 'done').length;
    const errorCount = transitions.filter((t) =>
      t.task.sessions.some((s) => s.status === 'error'),
    ).length;

    const parts: string[] = [];
    if (waitingCount > 0) {
      parts.push(`${waitingCount} waiting`);
    }
    if (doneCount > 0) {
      parts.push(`${doneCount} done`);
    }
    if (errorCount > 0) {
      parts.push(`${errorCount} errored`);
    }

    const summary = `${transitions.length} tasks changed: ${parts.join(', ')}`;

    vscode.window
      .showInformationMessage(summary, 'Show Sessions')
      .then((action) => {
        if (action === 'Show Sessions') {
          vscode.commands.executeCommand('claude-tower.sessions.focus');
        }
      });
  }

  dispose(): void {
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = undefined;
    }
  }
}
