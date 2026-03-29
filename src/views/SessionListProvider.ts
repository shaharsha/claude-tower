import * as vscode from 'vscode';
import type { TowerStateManager } from '../state/TowerStateManager';
import type { TowerSession } from '../types';
import { StatusGroupItem, SessionListItem, LoadMoreItem, ReadyItem, formatElapsed, formatElapsedCompact } from './items';

const PAGE_SIZE = 20;

interface FlatSession {
  session: TowerSession;
  projectName: string;
  branch: string;
  worktreePath: string;
}

export class SessionListProvider
  implements vscode.TreeDataProvider<vscode.TreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private stateManager: TowerStateManager;
  private context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private doneLimit = PAGE_SIZE;

  /** Stable "working since" timestamps — not re-derived from JSONL each poll */
  private workingSince = new Map<string, number>();
  /** 1-second tick timer for live elapsed display on running sessions */
  private tickTimer: NodeJS.Timeout | undefined;
  /** Items needing live updates — kept between renders for per-item refresh */
  private liveItems: SessionListItem[] = [];
  constructor(stateManager: TowerStateManager, context: vscode.ExtensionContext) {
    this.stateManager = stateManager;
    this.context = context;

    // Bootstrap: mark all existing sessions as "read" so they don't flood "To Review"
    if (!context.globalState.get<number>('claude-tower.toReviewActivatedAt')) {
      context.globalState.update('claude-tower.toReviewActivatedAt', Date.now());
    }

    this.disposables.push(
      stateManager.onDidChange(() => {
        this._onDidChangeTreeData.fire();
      }),
    );
  }

  /** Show more Done sessions */
  loadMore(): void {
    this.doneLimit += PAGE_SIZE;
    this._onDidChangeTreeData.fire();
  }

  /** Mark a session as read (user opened it) */
  markRead(sessionId: string): void {
    this.context.globalState.update(`claude-tower.sessionRead.${sessionId}`, Date.now());
    this._onDidChangeTreeData.fire();
  }

  /** Check if a session has been read since it last updated */
  private isRead(session: TowerSession, worktreePath?: string, openPaths?: Set<string>): boolean {
    // Explicitly marked read by user (via Claude Tower)
    const readAt = this.context.globalState.get<number>(`claude-tower.sessionRead.${session.id}`);
    if (readAt && readAt >= session.updatedAt) { return true; }
    // Sessions from before the To Review feature was enabled are considered read
    const activatedAt = this.context.globalState.get<number>('claude-tower.toReviewActivatedAt');
    if (activatedAt && session.updatedAt < activatedAt) { return true; }
    // Auto-detect: session has an alive --resume process
    if (session.hasAliveProcess) { return true; }
    // Auto-detect: session's worktree is open in any VS Code window
    // (current workspace OR any window with a Claude process for this path)
    if (worktreePath && openPaths?.has(worktreePath)) { return true; }
    return false;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof StatusGroupItem) {
      return element.children;
    }

    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this.stopTicking();
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private startTicking(): void {
    if (this.tickTimer) { return; }
    this.tickTimer = setInterval(() => {
      for (const item of this.liveItems) {
        const s = item.session;
        const ctx = item.contextStr;
        const since = this.workingSince.get(s.id);

        if (s.status === 'working' && since) {
          item.description = `${formatElapsed(Date.now() - since)} · ${ctx}`;
        } else if (s.status === 'waiting') {
          item.description = `waiting ${formatElapsedCompact(Date.now() - s.updatedAt)} · ${ctx}`;
        } else if (s.status === 'error') {
          item.description = `errored ${formatElapsedCompact(Date.now() - s.updatedAt)} ago · ${ctx}`;
        } else if (s.lastUserMessageAt && s.updatedAt - s.lastUserMessageAt > 10_000
                   && s.updatedAt - s.lastUserMessageAt < 7_200_000) {
          const ago = formatElapsedCompact(Date.now() - s.updatedAt);
          const took = formatElapsedCompact(s.updatedAt - s.lastUserMessageAt);
          item.description = `${ago} ago · took ${took} · ${ctx}`;
        } else {
          item.description = `${formatElapsedCompact(Date.now() - s.updatedAt)} ago · ${ctx}`;
        }
        this._onDidChangeTreeData.fire(item);
      }
    }, 1000);
  }

  private stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private getRootChildren(): vscode.TreeItem[] {
    // Show a loading indicator until the first real refresh completes
    // (cached state has empty session arrays — don't show welcome message for that)
    if (!this.stateManager.hasCompletedRefresh) {
      const item = new vscode.TreeItem('Loading sessions...');
      item.iconPath = new vscode.ThemeIcon('sync');
      return [item];
    }

    const projects = this.stateManager.getProjects();

    // Flatten all sessions across all projects/worktrees
    const flat: FlatSession[] = [];
    for (const project of projects) {
      for (const wt of project.worktrees) {
        for (const session of wt.sessions ?? []) {
          flat.push({
            session,
            projectName: project.name,
            branch: wt.branch,
            worktreePath: wt.path,
          });
        }
      }
    }

    // Empty state — no sessions found after loading
    if (flat.length === 0) {
      const item = new vscode.TreeItem('No active sessions');
      item.iconPath = new vscode.ThemeIcon('info');
      item.command = { command: 'claude-tower.newAction', title: 'New Chat' };
      item.tooltip = 'Click to start a new chat, or use the + button above';
      return [item];
    }

    // Track stable "working since" timestamps and apply grace period
    const now = Date.now();
    for (const f of flat) {
      if (f.session.status === 'working') {

        if (!this.workingSince.has(f.session.id)) {
          this.workingSince.set(f.session.id, f.session.lastUserMessageAt ?? now);
        }
      } else if (this.workingSince.has(f.session.id)) {
        // Session stopped working — clean up immediately.
        // Hooks provide definitive status, no UI grace needed.
        this.workingSince.delete(f.session.id);
      }
    }

    const currentlyWorking = new Set(
      flat.filter((f) => f.session.status === 'working').map((f) => f.session.id),
    );

    // Prune stale entries for sessions no longer in state
    const activeIds = new Set(flat.map((f) => f.session.id));
    for (const id of this.workingSince.keys()) {
      if (!activeIds.has(id)) { this.workingSince.delete(id); }
    }

    // Group by status category
    const needsAttention = flat.filter(
      (f) => f.session.status === 'waiting' || f.session.status === 'error',
    );
    const working = flat.filter((f) => f.session.status === 'working');
    const completed = flat.filter(
      (f) => f.session.status === 'done' || f.session.status === 'idle',
    );

    // Collect all paths with open VS Code windows (from alive process CWDs)
    const openPaths = new Set<string>();
    const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (currentWorkspace) { openPaths.add(currentWorkspace); }
    // Also add CWDs of all alive Claude processes (other VS Code windows)
    for (const project of projects) {
      for (const wt of project.worktrees) {
        for (const s of wt.sessions ?? []) {
          if (s.hasAliveProcess) {
            openPaths.add(wt.path);
          }
        }
      }
    }

    // Split completed into: To Review (unread), Recent (read, last 2h), Done (older)
    const RECENT_CUTOFF_MS = 2 * 60 * 60 * 1000; // 2 hours
    const recentCutoff = now - RECENT_CUTOFF_MS;

    const toReview = completed.filter((f) => !this.isRead(f.session, f.worktreePath, openPaths));
    const recent = completed.filter(
      (f) => this.isRead(f.session, f.worktreePath, openPaths) && f.session.updatedAt >= recentCutoff,
    );
    const done = completed.filter(
      (f) => this.isRead(f.session, f.worktreePath, openPaths) && f.session.updatedAt < recentCutoff,
    );

    // Sort each group by most recently updated first
    const byRecent = (a: FlatSession, b: FlatSession) =>
      b.session.updatedAt - a.session.updatedAt;
    working.sort(byRecent);
    toReview.sort(byRecent);
    recent.sort(byRecent);
    done.sort(byRecent);

    // Tick every second when there are items needing live updates
    // (determined AFTER liveItems is built, below)
    // Moved tick control to after liveItems population

    const totalDone = done.length;
    const hasMore = totalDone > this.doneLimit;
    const visibleDone = done.slice(0, this.doneLimit);

    const groups: vscode.TreeItem[] = [];

    if (needsAttention.length > 0) {
      // Sort: errors first (more urgent), then waiting
      needsAttention.sort((a, b) => {
        if (a.session.status === 'error' && b.session.status !== 'error') { return -1; }
        if (a.session.status !== 'error' && b.session.status === 'error') { return 1; }
        return b.session.updatedAt - a.session.updatedAt;
      });
      groups.push(
        new StatusGroupItem(
          'Needs Attention',
          needsAttention.length,
          'bell-dot',
          'charts.yellow',
          needsAttention.map((f) => toItem(f)),
          true,
        ),
      );
    }

    if (working.length > 0) {
      groups.push(
        new StatusGroupItem(
          'Running',
          working.length,
          'play',
          'charts.green',
          working.map((f) => toItem(f, this.workingSince.get(f.session.id))),
          true,
        ),
      );
    }

    // Show pending worktrees that don't have sessions yet
    const pendingWorktrees = this.stateManager.getPendingWorktrees();
    if (pendingWorktrees.length > 0) {
      groups.push(
        new StatusGroupItem(
          'New Worktrees',
          pendingWorktrees.length,
          'git-branch',
          'charts.purple',
          pendingWorktrees.map((p) => new ReadyItem(p)),
          true,
        ),
      );
    }

    if (toReview.length > 0) {
      groups.push(
        new StatusGroupItem(
          'To Review',
          toReview.length,
          'eye',
          'charts.blue',
          toReview.map((f) => toItem(f, undefined, true)),
          true,
        ),
      );
    }

    if (recent.length > 0) {
      groups.push(
        new StatusGroupItem(
          'Recent',
          recent.length,
          'history',
          undefined,
          recent.map((f) => toItem(f)),
          true,
        ),
      );
    }

    if (visibleDone.length > 0) {
      const doneChildren: vscode.TreeItem[] = visibleDone.map((f) => toItem(f));
      if (hasMore) {
        doneChildren.push(new LoadMoreItem(totalDone - this.doneLimit));
      }
      groups.push(
        new StatusGroupItem(
          'Done',
          totalDone,
          'check',
          'disabledForeground',
          doneChildren,
          true,
        ),
      );
    }

    // Collect items that need live per-second updates (Running + Needs Attention)
    // Collect items needing live per-second updates:
    // Running/Waiting (live counters) + To Review/Recent (ticking "ago" times)
    // Exclude Done items (160+ items, timestamps change at hour/day granularity)
    const liveGroupNames = new Set(['Running', 'Needs Attention', 'To Review', 'Recent']);
    this.liveItems = [];
    for (const group of groups) {
      if (group instanceof StatusGroupItem && liveGroupNames.has(group.label as string)) {
        for (const child of group.children) {
          if (child instanceof SessionListItem) {
            this.liveItems.push(child);
          }
        }
      }
    }

    if (this.liveItems.length > 0) {
      this.startTicking();
    } else {
      this.stopTicking();
    }

    return groups;
  }
}

function toItem(flat: FlatSession, workingSince?: number, isToReview?: boolean): SessionListItem {
  return new SessionListItem(
    flat.session,
    flat.worktreePath,
    flat.projectName,
    flat.branch,
    workingSince,
    isToReview,
  );
}
