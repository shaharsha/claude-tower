import * as vscode from 'vscode';
import type { TowerStateManager } from '../state/TowerStateManager';
import type { TowerSession } from '../types';
import type { GroupData, SessionItemData, WebviewToExtension } from './sessionWebviewMessages';
import { buildSessionsHtml } from './sessionWebviewHtml';
import { formatElapsed, formatElapsedCompact } from '../util/formatTime';

const PAGE_SIZE = 20;

interface FlatSession {
  session: TowerSession;
  projectName: string;
  branch: string;
  worktreePath: string;
}

export class SessionWebviewProvider implements vscode.WebviewViewProvider {
  private views: vscode.WebviewView[] = [];
  private disposables: vscode.Disposable[] = [];
  private doneLimit = PAGE_SIZE;
  private workingSince = new Map<string, number>();
  private tickTimer: NodeJS.Timeout | undefined;
  private liveItems: { id: string; session: TowerSession; contextStr: string }[] = [];

  constructor(
    private stateManager: TowerStateManager,
    private extensionContext: vscode.ExtensionContext,
  ) {
    // Bootstrap: mark all existing sessions as "read" so they don't flood "To Review"
    if (!extensionContext.globalState.get<number>('claude-tower.toReviewActivatedAt')) {
      extensionContext.globalState.update('claude-tower.toReviewActivatedAt', Date.now());
    }

    this.disposables.push(
      stateManager.onDidChange(() => this.updateAllViews()),
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.views.push(webviewView);

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionContext.extensionUri, 'node_modules'),
      ],
    };

    const nonce = getNonce();
    webviewView.webview.html = buildSessionsHtml(
      webviewView.webview,
      this.extensionContext.extensionUri,
      nonce,
    );

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExtension) => this.handleMessage(msg),
      undefined,
      this.disposables,
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.updateAllViews();
      }
    }, undefined, this.disposables);

    webviewView.onDidDispose(() => {
      this.views = this.views.filter((v) => v !== webviewView);
      if (this.views.length === 0) {
        this.stopTicking();
      }
    });

    // Initial render
    this.updateView(webviewView);
  }

  loadMore(): void {
    this.doneLimit += PAGE_SIZE;
    this.updateAllViews();
  }

  markRead(sessionId: string): void {
    this.extensionContext.globalState.update(`claude-tower.sessionRead.${sessionId}`, Date.now());
    this.updateAllViews();
  }

  setBadge(value: number, tooltip: string): void {
    for (const view of this.views) {
      view.badge = value > 0 ? { value, tooltip } : undefined;
    }
  }

  dispose(): void {
    this.stopTicking();
    for (const d of this.disposables) { d.dispose(); }
  }

  // ── Private ───────────────────────────────────────────────

  private updateAllViews(): void {
    for (const view of this.views) {
      if (view.visible) {
        this.updateView(view);
      }
    }
  }

  private updateView(view: vscode.WebviewView): void {
    const { groups, liveItems } = this.buildGroups();
    this.liveItems = liveItems;

    view.webview.postMessage({
      type: 'render',
      groups,
      loading: !this.stateManager.hasCompletedRefresh,
    });

    if (liveItems.length > 0) {
      this.startTicking();
    } else {
      this.stopTicking();
    }
  }

  private buildGroups(): { groups: GroupData[]; liveItems: typeof this.liveItems } {
    if (!this.stateManager.hasCompletedRefresh) {
      return { groups: [], liveItems: [] };
    }

    const projects = this.stateManager.getProjects();
    const now = Date.now();

    // Flatten all sessions
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

    // Track working-since timestamps
    for (const f of flat) {
      if (f.session.status === 'working') {
        if (!this.workingSince.has(f.session.id)) {
          this.workingSince.set(f.session.id, f.session.lastUserMessageAt ?? now);
        }
      } else {
        this.workingSince.delete(f.session.id);
      }
    }
    const activeIds = new Set(flat.map((f) => f.session.id));
    for (const id of this.workingSince.keys()) {
      if (!activeIds.has(id)) { this.workingSince.delete(id); }
    }

    // Collect open paths for read detection
    const openPaths = new Set<string>();
    const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (currentWorkspace) { openPaths.add(currentWorkspace); }
    for (const project of projects) {
      for (const wt of project.worktrees) {
        for (const s of wt.sessions ?? []) {
          if (s.hasAliveProcess) { openPaths.add(wt.path); }
        }
      }
    }

    // Group by status
    const needsAttention = flat.filter((f) => f.session.status === 'waiting' || f.session.status === 'error');
    const working = flat.filter((f) => f.session.status === 'working');
    const completed = flat.filter((f) => f.session.status === 'done' || f.session.status === 'idle');

    const RECENT_CUTOFF_MS = 2 * 60 * 60 * 1000;
    const recentCutoff = now - RECENT_CUTOFF_MS;
    const toReview = completed.filter((f) => !this.isRead(f.session, f.worktreePath, openPaths));
    const recent = completed.filter((f) => this.isRead(f.session, f.worktreePath, openPaths) && f.session.updatedAt >= recentCutoff);
    const done = completed.filter((f) => this.isRead(f.session, f.worktreePath, openPaths) && f.session.updatedAt < recentCutoff);

    const byRecent = (a: FlatSession, b: FlatSession) => b.session.updatedAt - a.session.updatedAt;
    working.sort(byRecent);
    toReview.sort(byRecent);
    recent.sort(byRecent);
    done.sort(byRecent);
    needsAttention.sort((a, b) => {
      if (a.session.status === 'error' && b.session.status !== 'error') { return -1; }
      if (a.session.status !== 'error' && b.session.status === 'error') { return 1; }
      return b.session.updatedAt - a.session.updatedAt;
    });

    const totalDone = done.length;
    const visibleDone = done.slice(0, this.doneLimit);
    const pendingWorktrees = this.stateManager.getPendingWorktrees();

    const groups: GroupData[] = [];
    const liveItems: typeof this.liveItems = [];

    const toSessionItem = (f: FlatSession, isToReview = false): SessionItemData => {
      const context = f.branch !== f.projectName ? `${f.projectName} · ${f.branch}` : f.projectName;
      const since = this.workingSince.get(f.session.id);
      let description: string;

      if (f.session.status === 'working' && since) {
        description = `${formatElapsed(now - since)} · ${context}`;
      } else if (f.session.status === 'waiting') {
        description = `waiting ${formatElapsedCompact(now - f.session.updatedAt)} · ${context}`;
      } else if (f.session.status === 'error') {
        description = `errored ${formatElapsedCompact(now - f.session.updatedAt)} ago · ${context}`;
      } else if (f.session.lastUserMessageAt
                 && f.session.updatedAt - f.session.lastUserMessageAt > 10_000
                 && f.session.updatedAt - f.session.lastUserMessageAt < 7_200_000) {
        const ago = formatElapsedCompact(now - f.session.updatedAt);
        const took = formatElapsedCompact(f.session.updatedAt - f.session.lastUserMessageAt);
        description = `${ago} ago · took ${took} · ${context}`;
      } else {
        description = `${formatElapsedCompact(now - f.session.updatedAt)} ago · ${context}`;
      }

      const summary = (f.session.summary || `Session ${f.session.id.slice(0, 8)}`)
        .replace(/^You are working on:\s*/i, '');

      const STATUS_LABELS: Record<string, string> = {
        working: 'Working',
        waiting: 'Waiting for approval',
        done: 'Done',
        error: 'Error',
        idle: 'Idle',
      };
      const tooltip = `${summary}\n${STATUS_LABELS[f.session.status] ?? f.session.status}\n${f.projectName} · ${f.branch}\n${f.session.messageCount} messages · ${formatElapsedCompact(now - f.session.updatedAt)} ago`;

      return {
        id: f.session.id,
        summary,
        status: f.session.status,
        description,
        worktreePath: f.worktreePath,
        showShip: f.session.status !== 'working' && f.session.status !== 'waiting',
        showOpen: true,
        toReview: isToReview,
        tooltip,
      };
    };

    if (needsAttention.length > 0) {
      const items = needsAttention.map((f) => toSessionItem(f));
      groups.push({ name: 'Needs Attention', count: needsAttention.length, icon: 'bell-dot', color: 'needs-attention', expanded: true, items });
      for (const f of needsAttention) {
        const ctx = f.branch !== f.projectName ? `${f.projectName} · ${f.branch}` : f.projectName;
        liveItems.push({ id: f.session.id, session: f.session, contextStr: ctx });
      }
    }

    if (working.length > 0) {
      const items = working.map((f) => toSessionItem(f));
      groups.push({ name: 'Running', count: working.length, icon: 'play', color: 'running', expanded: true, items });
      for (const f of working) {
        const ctx = f.branch !== f.projectName ? `${f.projectName} · ${f.branch}` : f.projectName;
        liveItems.push({ id: f.session.id, session: f.session, contextStr: ctx });
      }
    }

    if (pendingWorktrees.length > 0) {
      groups.push({
        name: 'New Worktrees', count: pendingWorktrees.length, icon: 'git-branch', color: 'new-worktrees', expanded: true,
        items: pendingWorktrees.map((p) => ({
          type: 'ready' as const,
          worktreePath: p.path,
          branch: p.branch,
          label: p.label || p.branch,
          description: `${formatElapsedCompact(now - p.createdAt)} ago · ${p.branch}`,
        })),
      });
    }

    if (toReview.length > 0) {
      const items = toReview.map((f) => toSessionItem(f, true));
      groups.push({ name: 'To Review', count: toReview.length, icon: 'eye', color: 'to-review', expanded: true, items });
      for (const f of toReview) {
        const ctx = f.branch !== f.projectName ? `${f.projectName} · ${f.branch}` : f.projectName;
        liveItems.push({ id: f.session.id, session: f.session, contextStr: ctx });
      }
    }

    if (recent.length > 0) {
      const items = recent.map((f) => toSessionItem(f));
      groups.push({ name: 'Recent', count: recent.length, icon: 'history', color: 'recent', expanded: true, items });
      for (const f of recent) {
        const ctx = f.branch !== f.projectName ? `${f.projectName} · ${f.branch}` : f.projectName;
        liveItems.push({ id: f.session.id, session: f.session, contextStr: ctx });
      }
    }

    if (visibleDone.length > 0) {
      const items: GroupData['items'] = visibleDone.map((f) => toSessionItem(f));
      if (totalDone > this.doneLimit) {
        items.push({ type: 'loadMore', remaining: totalDone - this.doneLimit });
      }
      groups.push({ name: 'Done', count: totalDone, icon: 'check', color: 'done', expanded: true, items });
    }

    return { groups, liveItems };
  }

  private isRead(session: TowerSession, worktreePath?: string, openPaths?: Set<string>): boolean {
    const readAt = this.extensionContext.globalState.get<number>(`claude-tower.sessionRead.${session.id}`);
    if (readAt && readAt >= session.updatedAt) { return true; }
    const activatedAt = this.extensionContext.globalState.get<number>('claude-tower.toReviewActivatedAt');
    if (activatedAt && session.updatedAt < activatedAt) { return true; }
    if (session.hasAliveProcess) { return true; }
    if (worktreePath && openPaths?.has(worktreePath)) { return true; }
    return false;
  }

  private startTicking(): void {
    if (this.tickTimer) { return; }
    this.tickTimer = setInterval(() => {
      const now = Date.now();
      const updates: { id: string; description: string }[] = [];

      for (const item of this.liveItems) {
        const s = item.session;
        const ctx = item.contextStr;
        const since = this.workingSince.get(s.id);
        let desc: string;

        if (s.status === 'working' && since) {
          desc = `${formatElapsed(now - since)} · ${ctx}`;
        } else if (s.status === 'waiting') {
          desc = `waiting ${formatElapsedCompact(now - s.updatedAt)} · ${ctx}`;
        } else if (s.status === 'error') {
          desc = `errored ${formatElapsedCompact(now - s.updatedAt)} ago · ${ctx}`;
        } else if (s.lastUserMessageAt && s.updatedAt - s.lastUserMessageAt > 10_000
                   && s.updatedAt - s.lastUserMessageAt < 7_200_000) {
          const ago = formatElapsedCompact(now - s.updatedAt);
          const took = formatElapsedCompact(s.updatedAt - s.lastUserMessageAt);
          desc = `${ago} ago · took ${took} · ${ctx}`;
        } else {
          desc = `${formatElapsedCompact(now - s.updatedAt)} ago · ${ctx}`;
        }
        updates.push({ id: item.id, description: desc });
      }

      for (const view of this.views) {
        if (view.visible) {
          view.webview.postMessage({ type: 'tick', updates });
        }
      }
    }, 1000);
  }

  private stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private handleMessage(msg: WebviewToExtension): void {
    switch (msg.type) {
      case 'openSession':
        vscode.commands.executeCommand('claude-tower.openSession', msg.worktreePath, msg.sessionId);
        break;
      case 'shipSession':
        vscode.commands.executeCommand('claude-tower.shipSession', { _worktreePath: msg.worktreePath, _sessionId: msg.sessionId });
        break;
      case 'removeWorktree':
        vscode.commands.executeCommand('claude-tower.removeWorktree', { _worktreePath: msg.worktreePath });
        break;
      case 'newSession':
        vscode.commands.executeCommand('claude-tower.newSession', msg.worktreePath);
        break;
      case 'openWorktree':
        vscode.commands.executeCommand('claude-tower.openWorktree', msg.worktreePath);
        break;
      case 'loadMore':
        this.loadMore();
        break;
      case 'markRead':
        this.markRead(msg.sessionId);
        break;
    }
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
