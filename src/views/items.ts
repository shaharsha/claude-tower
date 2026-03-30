import * as vscode from 'vscode';
import type { TowerSession } from '../types';

// ============================================================
// Helpers
// ============================================================

/**
 * Convert a duration in milliseconds to a human-readable elapsed string.
 * Examples: "2m", "1h", "3h", "1d"
 */
/** Precise elapsed: 45s, 2m 30s, 1h 5m 30s — for Running counters */
export function formatElapsed(sinceMs: number): string {
  const seconds = Math.floor(sinceMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) {
    return remainingSec > 0 ? `${minutes}m ${remainingSec}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  if (hours < 24) {
    return remainingMin > 0 ? `${hours}h ${remainingMin}m ${remainingSec}s` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Compact elapsed: 45s, 2m, 1h, 3d — for non-running items (ago, took) */
export function formatElapsedCompact(sinceMs: number): string {
  const seconds = Math.floor(sinceMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}


// ============================================================
// StatusGroupItem (for Sessions view)
// ============================================================

export class StatusGroupItem extends vscode.TreeItem {
  public readonly children: vscode.TreeItem[];

  constructor(
    label: string,
    count: number | string,
    iconName: string,
    colorId: string | undefined,
    children: vscode.TreeItem[],
    expandedByDefault: boolean,
  ) {
    super(
      label,
      expandedByDefault
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.children = children;
    this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon(
      iconName,
      colorId ? new vscode.ThemeColor(colorId) : undefined,
    );
    this.contextValue = 'status-group';
  }
}

// ============================================================
// SessionListItem (for Sessions view — includes project context)
// ============================================================

export class SessionListItem extends vscode.TreeItem {
  public readonly session: TowerSession;
  public readonly worktreePath: string;
  /** Stored for live description updates during tick */
  public readonly contextStr: string;

  constructor(
    session: TowerSession,
    worktreePath: string,
    projectName: string,
    branch: string,
    workingSince?: number,
    isToReview?: boolean,
  ) {
    const label = session.summary || `Session ${session.id.slice(0, 8)}`;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.session = session;
    this.worktreePath = worktreePath;
    // Differentiate running from completed for context menu (Ship only on completed)
    this.contextValue = (session.status === 'working' || session.status === 'waiting')
      ? 'session-active'
      : 'session';
    const STATUS_COLORS: Record<string, string> = {
      working: 'charts.green',
      waiting: 'charts.yellow',
      error: 'charts.red',
      done: 'disabledForeground',
      idle: 'disabledForeground',
    };
    // "To Review" items get blue bullets to stand out as unread
    const colorId = isToReview ? 'charts.blue' : STATUS_COLORS[session.status];
    this.iconPath = new vscode.ThemeIcon(
      'circle-filled',
      colorId ? new vscode.ThemeColor(colorId) : undefined,
    );

    // Description: timing first (most important, survives truncation), then context
    const context = branch !== projectName ? `${projectName} · ${branch}` : projectName;
    this.contextStr = context;
    if (session.status === 'working' && workingSince) {
      this.description = `${formatElapsed(Date.now() - workingSince)} · ${context}`;
    } else if (session.status === 'waiting') {
      this.description = `waiting ${formatElapsedCompact(Date.now() - session.updatedAt)} · ${context}`;
    } else if (session.status === 'error') {
      this.description = `errored ${formatElapsedCompact(Date.now() - session.updatedAt)} ago · ${context}`;
    } else if (session.lastUserMessageAt
               && session.updatedAt - session.lastUserMessageAt > 10_000
               && session.updatedAt - session.lastUserMessageAt < 7_200_000) {
      const ago = formatElapsedCompact(Date.now() - session.updatedAt);
      const turnDuration = formatElapsedCompact(session.updatedAt - session.lastUserMessageAt);
      this.description = `${ago} ago · took ${turnDuration} · ${context}`;
    } else {
      this.description = `${formatElapsedCompact(Date.now() - session.updatedAt)} ago · ${context}`;
    }

    // Tooltip
    const STATUS_LABELS: Record<string, string> = {
      working: 'Working — Claude is running',
      waiting: 'Waiting — needs your approval',
      done: 'Done — session finished',
      error: 'Error — session hit an error',
      idle: 'Idle — no active session',
    };
    const tooltipElapsed = formatElapsed(Date.now() - session.updatedAt);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${label}**\n\n`);
    md.appendMarkdown(`${STATUS_LABELS[session.status] ?? session.status}\n\n`);
    md.appendMarkdown(`${projectName} · ${branch}\n\n`);
    md.appendMarkdown(`${session.messageCount} messages · ${tooltipElapsed} ago`);
    this.tooltip = md;

    // Store args for inline action command (same contract as SessionItem)
    (this as any)._worktreePath = worktreePath;
    (this as any)._sessionId = session.id;

    // Double-click (or single-click depending on VS Code setting) opens the session
    this.command = {
      command: 'claude-tower.openSession',
      title: 'Open Chat',
      arguments: [this],
    };
  }
}

// ============================================================
// ReadyItem (pending worktree without sessions)
// ============================================================

export class ReadyItem extends vscode.TreeItem {
  public readonly worktreePath: string;

  constructor(pending: { path: string; branch: string; label?: string; createdAt: number }) {
    const label = pending.label || pending.branch;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.worktreePath = pending.path;
    this.contextValue = 'ready-worktree';
    this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.purple'));

    const elapsed = formatElapsedCompact(Date.now() - pending.createdAt);
    this.description = `${elapsed} ago · ${pending.branch}`;
    this.tooltip = `Worktree ready at ${pending.path}\nClick to open and start working`;

    // Click → open the worktree in VS Code
    this.command = {
      command: 'claude-tower.openWorktree',
      title: 'Open in VS Code',
      arguments: [pending.path],
    };
  }
}

// ============================================================
// LoadMoreItem (for paginated Done group)
// ============================================================

export class LoadMoreItem extends vscode.TreeItem {
  constructor(remaining: number) {
    super(`Load ${Math.min(remaining, 20)} more...`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('ellipsis');
    this.contextValue = 'load-more';
    this.command = {
      command: 'claude-tower.loadMoreSessions',
      title: 'Load More',
    };
    this.description = `${remaining} remaining`;
  }
}

