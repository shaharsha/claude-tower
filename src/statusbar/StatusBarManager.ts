import * as vscode from 'vscode';
import { TowerTask } from '../types';

export class StatusBarManager {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    this.statusBarItem.command = 'claude-tower.sessions.focus';
    this.statusBarItem.show();
  }

  /**
   * Update the status bar text and background based on current task states.
   */
  update(tasks: TowerTask[]): void {
    const working = tasks.filter((t) => t.status === 'in-progress');
    const waiting = tasks.filter((t) => t.status === 'waiting');
    const review = tasks.filter((t) => t.status === 'review');
    const errored = tasks.filter((t) =>
      t.sessions.some((s) => s.status === 'error'),
    );

    // Build text
    const parts: string[] = [];

    // Working count is always shown
    parts.push(`$(radio-tower) ${working.length} working`);

    // Waiting
    if (waiting.length === 1) {
      const ticket = waiting[0].branch ?? waiting[0].title;
      parts.push(`$(bell) ${ticket} waiting`);
    } else if (waiting.length > 1) {
      parts.push(`${waiting.length} waiting`);
    }

    // Review
    if (review.length > 0) {
      parts.push(`${review.length} review`);
    }

    this.statusBarItem.text = parts.join(' \u00b7 ');

    // Tooltip
    this.statusBarItem.tooltip = `Claude Tower: ${working.length} working, ${waiting.length} waiting, ${review.length} review`;

    // Background color
    if (errored.length > 0) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground',
      );
    } else if (waiting.length > 0) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  // Badge is managed directly by extension.ts using TreeView.badge API

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
