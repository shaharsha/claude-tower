import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type {
  TowerState,
  TowerTask,
  TowerProject,
  TowerSession,
  TowerPersistedState,
  PersistedTask,
  TaskStatus,
} from '../types';
import { getClaudeProjectsDir, encodeProjectPath } from '../util/claudePaths';

import { ProjectScanner } from './ProjectScanner';
import { SessionScanner } from './SessionScanner';
import { ProcessMonitor } from './ProcessMonitor';
import { TaskBuilder } from './TaskBuilder';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const MIN_REFRESH_INTERVAL_MS = 1000;
const DEBUG = true; // TODO: set to process.env.CLAUDE_TOWER_DEBUG === '1' for production
const LOG_FILE = path.join(require('os').homedir(), '.claude-tower-debug.log');

function debugLog(msg: string): void {
  if (!DEBUG) { return; }
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}

export class TowerStateManager {
  private state: TowerState = { projects: [], tasks: [] };

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private pollInterval: NodeJS.Timeout | undefined;
  private fsWatcher: fs.FSWatcher | undefined;

  private projectScanner = new ProjectScanner();
  private sessionScanner = new SessionScanner();
  private processMonitor = new ProcessMonitor();
  private taskBuilder: TaskBuilder;

  private lastRefreshTime = 0;
  private refreshPending = false;
  private refreshInProgress = false;
  private _hasCompletedRefresh = false;
  private lastSessionRefreshTime = 0;
  private static readonly DEAD_TASK_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Load persisted tasks on construction
    const persisted = this.loadPersistedTasks();
    this.taskBuilder = new TaskBuilder(persisted);

    // Wire up read-state resolver backed by globalState
    this.taskBuilder.setReadStateResolver((taskId, updatedAt) => {
      const readAt = context.globalState.get<number>(`claude-tower.read.${taskId}`);
      if (!readAt) { return false; }
      return readAt > updatedAt;
    });
  }

  // ──────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────

  /**
   * Initialize the state manager: perform initial refresh, start polling,
   * and watch the projects directory for JSONL changes.
   */
  async activate(): Promise<void> {
    debugLog('activate() called');

    // Load cached state instantly so the UI renders immediately
    this.loadCachedState();

    // Refresh in the background (don't await — let the UI show cached data first)
    debugLog('Starting background refresh');
    this.refresh();

    // Start polling
    const config = vscode.workspace.getConfiguration('claude-tower');
    const pollMs = config.get<number>('pollIntervalMs', DEFAULT_POLL_INTERVAL_MS);

    this.pollInterval = setInterval(() => {
      this.refreshSessions();
    }, pollMs);

    // Watch ~/.claude/projects/ for JSONL file changes
    this.startFsWatcher();
  }

  /**
   * Clean up intervals, watchers, and event emitters.
   */
  deactivate(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = undefined;
    }

    this._onDidChange.dispose();
  }

  // ──────────────────────────────────────────────
  // Refresh
  // ──────────────────────────────────────────────

  /**
   * Full refresh: scan projects, scan sessions, build tasks.
   * Debounced to max 1 per second.
   */
  async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefreshTime < MIN_REFRESH_INTERVAL_MS) {
      // Schedule a deferred refresh if not already pending
      if (!this.refreshPending) {
        this.refreshPending = true;
        setTimeout(() => {
          this.refreshPending = false;
          this.refresh();
        }, MIN_REFRESH_INTERVAL_MS);
      }
      return;
    }

    if (this.refreshInProgress) {
      return;
    }

    this.refreshInProgress = true;
    this.lastRefreshTime = now;

    try {
      // 1. Scan projects (includes worktrees)
      const recentDays = vscode.workspace.getConfiguration('claude-tower').get<number>('recentDays', 7);
      const projects = await this.projectScanner.scanProjects(recentDays);

      // 2. Get alive process info (CWDs + session IDs from --resume flags)
      const aliveInfo = await this.processMonitor.getAliveProcessInfo();

      // 3. Scan sessions per-worktree, with progressive UI updates.
      //    Projects are sorted by most recent activity, so Running sessions
      //    appear in the first batch. Fire intermediate updates so the UI
      //    fills in progressively instead of waiting for all 160+ sessions.
      const sessionsMap = new Map<string, TowerSession[]>();
      // Only fire intermediate updates if we DON'T have cached sessions.
      // If cache already shows sessions, no need to flash partial data.
      const hasCachedSessions = this._hasCompletedRefresh;
      let firstUpdateFired = hasCachedSessions;

      for (const project of projects) {
        const projectSessions = await this.sessionScanner.scanSessions(
          project.id,
          aliveInfo,
          project.path,
        );
        sessionsMap.set(project.id, projectSessions);

        if (project.worktrees.length === 0 && projectSessions.length > 0) {
          project.worktrees.push({
            path: project.path,
            branch: project.name,
            isMain: true,
            isCurrentWindow: false,
            hasOpenWindow: false,
            sessions: projectSessions,
          });
        } else {
          for (const worktree of project.worktrees) {
            const encodedWt = encodeProjectPath(worktree.path);
            if (encodedWt === project.id) {
              worktree.sessions = projectSessions;
            } else {
              const wtSessions = await this.sessionScanner.scanSessions(
                encodedWt,
                aliveInfo,
                worktree.path,
              );
              worktree.sessions = wtSessions;
              sessionsMap.set(encodedWt, wtSessions);
            }
          }
        }

        // Fire after the FIRST project is scanned — shows Running sessions instantly.
        // Projects are sorted by most recent activity, so this is the most relevant one.
        if (!firstUpdateFired) {
          firstUpdateFired = true;
          this._hasCompletedRefresh = true;
          this.state = { projects, tasks: this.state.tasks };
          this._onDidChange.fire();
        }
      }

      // 4. Clean up dead tasks before loading
      this.cleanupDeadTasks();

      // 5. Reload persisted tasks (may have changed on disk)
      const persisted = this.loadPersistedTasks();
      this.taskBuilder.updatePersistedTasks(persisted);

      // 6. Build tasks
      const tasks = await this.taskBuilder.buildTasks(projects, sessionsMap);

      // 7. Final update with complete data
      debugLog(`Refresh done: ${projects.length} projects, ${tasks.length} tasks`);
      this._hasCompletedRefresh = true;
      this.state = { projects, tasks };
      this._onDidChange.fire();
      this.saveCachedState();
    } catch (err) {
      console.error('[claude-tower] refresh failed:', err);
    } finally {
      this.refreshInProgress = false;
    }
  }

  /**
   * Lightweight refresh: only re-scan sessions and update task statuses.
   * Does not re-scan projects, worktrees, or run git commands.
   * Debounced to max 1 per second.
   */
  async refreshSessions(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSessionRefreshTime < MIN_REFRESH_INTERVAL_MS) {
      return;
    }
    this.lastSessionRefreshTime = now;

    try {
      // Snapshot session state before update
      const oldSessionFingerprint = this.getSessionsFingerprint();

      const aliveInfo = await this.processMonitor.getAliveProcessInfo();

      // Scan sessions per-worktree
      const sessionsMap = new Map<string, TowerSession[]>();
      for (const project of this.state.projects) {
        const projectSessions = await this.sessionScanner.scanSessions(
          project.id,
          aliveInfo,
          project.path,
        );
        sessionsMap.set(project.id, projectSessions);

        for (const worktree of project.worktrees) {
          const encodedWt = encodeProjectPath(worktree.path);
          if (encodedWt === project.id) {
            worktree.sessions = projectSessions;
          } else {
            const wtSessions = await this.sessionScanner.scanSessions(
              encodedWt,
              aliveInfo,
              worktree.path,
            );
            worktree.sessions = wtSessions;
            sessionsMap.set(encodedWt, wtSessions);
          }
        }
      }

      // Rebuild tasks with fresh session data
      const tasks = await this.taskBuilder.buildTasks(
        this.state.projects,
        sessionsMap,
      );

      // Fire change event if tasks OR sessions changed
      const tasksChanged = this.hasTasksChanged(this.state.tasks, tasks);
      const sessionsChanged = this.getSessionsFingerprint() !== oldSessionFingerprint;
      this.state = { ...this.state, tasks };
      if (tasksChanged || sessionsChanged) {
        this._onDidChange.fire();
      }
    } catch (err) {
      console.error('[claude-tower] refreshSessions failed:', err);
    }
  }

  // ──────────────────────────────────────────────
  // Pending Worktrees
  // ──────────────────────────────────────────────

  /** Track a newly created worktree that doesn't have sessions yet */
  addPendingWorktree(worktreePath: string, branch: string, label?: string): void {
    const pending: Array<{ path: string; branch: string; label?: string; createdAt: number }> =
      this.context.globalState.get('claude-tower.pendingWorktrees') ?? [];
    // Avoid duplicates
    if (!pending.some((p) => p.path === worktreePath)) {
      pending.push({ path: worktreePath, branch, label, createdAt: Date.now() });
      this.context.globalState.update('claude-tower.pendingWorktrees', pending);
      this._onDidChange.fire();
    }
  }

  /** Get pending worktrees, removing any that now have sessions */
  getPendingWorktrees(): Array<{ path: string; branch: string; label?: string; createdAt: number }> {
    const pending: Array<{ path: string; branch: string; label?: string; createdAt: number }> =
      this.context.globalState.get('claude-tower.pendingWorktrees') ?? [];

    // Remove worktrees that now have sessions
    const worktreePathsWithSessions = new Set<string>();
    for (const project of this.state.projects) {
      for (const wt of project.worktrees) {
        if (wt.sessions && wt.sessions.length > 0) {
          worktreePathsWithSessions.add(wt.path);
        }
      }
    }

    const stillPending = pending.filter((p) => !worktreePathsWithSessions.has(p.path));
    if (stillPending.length !== pending.length) {
      this.context.globalState.update('claude-tower.pendingWorktrees', stillPending);
    }

    return stillPending;
  }

  /** Remove a pending worktree (e.g., when archived) */
  removePendingWorktree(worktreePath: string): void {
    const pending: Array<{ path: string; branch: string; label?: string; createdAt: number }> =
      this.context.globalState.get('claude-tower.pendingWorktrees') ?? [];
    const filtered = pending.filter((p) => p.path !== worktreePath);
    this.context.globalState.update('claude-tower.pendingWorktrees', filtered);
  }

  // ──────────────────────────────────────────────
  // Getters
  // ──────────────────────────────────────────────

  /** True after the first full refresh (projects + sessions) has completed */
  get hasCompletedRefresh(): boolean {
    return this._hasCompletedRefresh;
  }

  getState(): TowerState {
    return this.state;
  }

  getTasks(): TowerTask[] {
    return this.state.tasks;
  }

  getProjects(): TowerProject[] {
    return this.state.projects;
  }

  getTaskById(id: string): TowerTask | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  // ──────────────────────────────────────────────
  // Mutations
  // ──────────────────────────────────────────────

  /**
   * Create a new manual task in backlog.
   */
  addManualTask(
    title: string,
    projectPath: string,
    mode: 'worktree' | 'same-workspace',
  ): TowerTask {
    const now = Date.now();
    const id = crypto.randomUUID();

    const persisted: PersistedTask = {
      id,
      title,
      source: 'manual',
      mode,
      projectPath,
      sessionIds: [],
      status: 'backlog',
      createdAt: now,
      updatedAt: now,
    };

    // Add to persisted state
    this.persistState((state) => {
      state.tasks.push(persisted);
    });

    // Update in-memory task builder
    const currentPersisted = this.loadPersistedTasks();
    this.taskBuilder.updatePersistedTasks(currentPersisted);

    // Build the runtime task object
    const task: TowerTask = {
      id,
      title,
      status: 'backlog',
      source: 'manual',
      mode,
      projectPath,
      sessions: [],
      createdAt: now,
      updatedAt: now,
      isRead: true,
    };

    this.state.tasks.push(task);
    this._onDidChange.fire();

    return task;
  }

  /**
   * Update the status of a task.
   */
  updateTaskStatus(taskId: string, status: TaskStatus): void {
    this.persistState((state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) {
        task.status = status;
        task.updatedAt = Date.now();
      }
    });

    // Update in-memory
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (task) {
      task.status = status;
      task.updatedAt = Date.now();
      this._onDidChange.fire();
    }
  }

  /**
   * Permanently delete a task from both persisted and in-memory state.
   */
  deleteTask(taskId: string): void {
    this.persistState((state) => {
      state.tasks = state.tasks.filter((t) => t.id !== taskId);
    });

    // Sync the task builder so polling doesn't resurrect the deleted task
    const currentPersisted = this.loadPersistedTasks();
    this.taskBuilder.updatePersistedTasks(currentPersisted);

    this.state.tasks = this.state.tasks.filter((t) => t.id !== taskId);
    this._onDidChange.fire();
  }

  /**
   * Update additional fields on a persisted task (branch, worktreePath, linear fields, etc.).
   */
  updateTaskFields(
    taskId: string,
    fields: Partial<Pick<PersistedTask, 'branch' | 'worktreePath' | 'projectPath' | 'source' | 'mode' | 'linearIssueId' | 'linearIdentifier' | 'linearIssueUrl' | 'description'>>,
  ): void {
    this.persistState((state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (task) {
        Object.assign(task, fields);
        task.updatedAt = Date.now();
      }
    });

    // Also update in-memory task
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (task) {
      Object.assign(task, fields);
      task.updatedAt = Date.now();
    }
  }

  /**
   * Link a session to a task.
   */
  linkSession(taskId: string, sessionId: string): void {
    this.persistState((state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (task && !task.sessionIds.includes(sessionId)) {
        task.sessionIds.push(sessionId);
        task.updatedAt = Date.now();
      }
    });

    // Trigger a session refresh to pick up the new link
    this.refreshSessions().catch((err) => {
      console.error('[claude-tower] refreshSessions after linkSession failed:', err);
    });
  }

  /**
   * Mark a task as read (clears the unread indicator on review tasks).
   */
  markAsRead(taskId: string): void {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (task) {
      task.isRead = true;
      // Persist read timestamp to globalState for cross-refresh persistence
      this.context.globalState.update(`claude-tower.read.${taskId}`, Date.now());
      this._onDidChange.fire();
    }
  }

  /**
   * Build a fingerprint of all session IDs and statuses for change detection.
   */
  private getSessionsFingerprint(): string {
    const parts: string[] = [];
    for (const project of this.state.projects) {
      for (const wt of project.worktrees) {
        for (const s of wt.sessions ?? []) {
          parts.push(`${s.id}:${s.status}`);
        }
      }
    }
    return parts.sort().join('|');
  }

  /**
   * Quick check if tasks changed (by comparing IDs and statuses).
   */
  private hasTasksChanged(oldTasks: TowerTask[], newTasks: TowerTask[]): boolean {
    if (oldTasks.length !== newTasks.length) { return true; }
    for (let i = 0; i < oldTasks.length; i++) {
      if (oldTasks[i].id !== newTasks[i].id) { return true; }
      if (oldTasks[i].status !== newTasks[i].status) { return true; }
      if (oldTasks[i].isRead !== newTasks[i].isRead) { return true; }
    }
    return false;
  }

  // ──────────────────────────────────────────────
  // State cache (for instant startup)
  // ──────────────────────────────────────────────

  /**
   * Load cached project/task state from globalState for instant UI render.
   * The cache is a snapshot from the last successful refresh.
   */
  private loadCachedState(): void {
    try {
      const cached = this.context.globalState.get<TowerState>('claude-tower.stateCache');
      if (cached && Array.isArray(cached.projects) && cached.projects.length > 0) {
        this.state = cached;
        // If cached state has sessions, show them instantly (skip loading spinner)
        const hasSessions = cached.projects.some((p) =>
          p.worktrees?.some((w) => w.sessions?.length > 0),
        );
        if (hasSessions) {
          this._hasCompletedRefresh = true;
        }
        debugLog(`Loaded ${cached.projects.length} projects from cache (sessions: ${hasSessions})`);
        this._onDidChange.fire();
      } else {
        debugLog('No cached state found');
      }
    } catch {
      debugLog('Failed to load cached state');
    }
  }

  /**
   * Save current state to globalState for next startup.
   */
  private saveCachedState(): void {
    // Cache sessions for instant startup, but strip large text fields
    const cache: TowerState = {
      projects: this.state.projects.map((p) => ({
        ...p,
        worktrees: p.worktrees.map((w) => ({
          ...w,
          sessions: (w.sessions ?? []).map((s) => ({
            ...s,
            lastAssistantMessage: undefined, // Large text, skip
          })),
        })),
      })),
      tasks: this.state.tasks.map((t) => ({
        ...t,
        sessions: [],
      })),
    };
    this.context.globalState.update('claude-tower.stateCache', cache);
  }

  // ──────────────────────────────────────────────
  // Dead task cleanup
  // ──────────────────────────────────────────────

  /**
   * Remove persisted tasks that are dead: worktree removed, no sessions,
   * and older than 7 days.
   */
  private cleanupDeadTasks(): void {
    const now = Date.now();
    this.persistState((state) => {
      state.tasks = state.tasks.filter((t) => {
        if (t.status === 'done' && now - t.updatedAt > TowerStateManager.DEAD_TASK_AGE_MS) {
          // Check if worktree still exists
          if (t.worktreePath && !fs.existsSync(t.worktreePath)) {
            return false; // Remove dead task
          }
          if (t.sessionIds.length === 0) {
            return false; // No sessions, old -> remove
          }
        }
        return true;
      });
    });
  }

  // ──────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────

  /**
   * Get the path to the persisted state file for a given project.
   * State is stored per-project at <project-root>/.claude-tower/state.json
   */
  private getStateFilePath(projectPath?: string): string {
    const base = projectPath ?? this.getCurrentProjectPath();
    if (base) {
      return path.join(base, '.claude-tower', 'state.json');
    }
    // Fallback to global storage if no project is available
    return path.join(this.context.globalStorageUri.fsPath, 'state.json');
  }

  private getCurrentProjectPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * Load persisted tasks from state.json.
   */
  private loadPersistedTasks(): PersistedTask[] {
    try {
      const filePath = this.getStateFilePath();
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed: TowerPersistedState = JSON.parse(raw);
      if (parsed.version === 1 && Array.isArray(parsed.tasks)) {
        return parsed.tasks;
      }
    } catch {
      // File doesn't exist yet or is invalid
    }
    return [];
  }

  /**
   * Persist state to disk using atomic write (write to .tmp, then rename).
   * The updater function receives the current persisted state for mutation.
   */
  private persistState(
    updater: (state: TowerPersistedState) => void,
  ): void {
    const filePath = this.getStateFilePath();
    const tmpPath = filePath + '.tmp';

    // Ensure directory exists
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    // Load current state
    let state: TowerPersistedState;
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      state = JSON.parse(raw);
      if (state.version !== 1 || !Array.isArray(state.tasks)) {
        state = { version: 1, tasks: [] };
      }
    } catch {
      state = { version: 1, tasks: [] };
    }

    // Apply mutation
    updater(state);

    // Atomic write
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  // ──────────────────────────────────────────────
  // FS Watcher
  // ──────────────────────────────────────────────

  /**
   * Watch the Claude projects directory for JSONL file changes.
   * Triggers a lightweight session refresh on changes.
   */
  private fsWatchDebounceTimer: NodeJS.Timeout | undefined;

  private startFsWatcher(): void {
    const projectsDir = getClaudeProjectsDir();

    try {
      this.fsWatcher = fs.watch(
        projectsDir,
        { recursive: true },
        (eventType, filename) => {
          if (filename && filename.endsWith('.jsonl')) {
            // Check if this JSONL is from a known project or a new one
            const encodedDir = filename.split('/')[0] ?? filename.split('\\')[0];
            const isKnownProject = this.state.projects.some(
              (p) => p.id === encodedDir ||
                p.worktrees.some((w) => encodeProjectPath(w.path) === encodedDir),
            );

            if (this.fsWatchDebounceTimer) { clearTimeout(this.fsWatchDebounceTimer); }
            this.fsWatchDebounceTimer = setTimeout(() => {
              this.fsWatchDebounceTimer = undefined;
              if (isKnownProject) {
                this.refreshSessions();
              } else {
                // New project/worktree detected — full refresh to discover it
                this.refresh();
              }
            }, 500);
          }
        },
      );

      this.fsWatcher.on('error', (err) => {
        console.error('[claude-tower] fs watcher error:', err);
        // Don't crash — polling will continue working
      });
    } catch (err) {
      console.error('[claude-tower] failed to start fs watcher:', err);
      // Polling is still active as a fallback
    }
  }
}
