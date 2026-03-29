import type {
  TowerTask,
  TowerSession,
  TowerProject,
  PersistedTask,
  TaskStatus,
  SessionStatus,
  DiffStat,
} from '../types';
import { extractApprovalPreview } from '../util/approvalPreview';
import { computeDiffStat } from '../util/diffStat';
import { readJsonlTail } from '../util/jsonlReader';
import { getSessionsDir, encodeProjectPath } from '../util/claudePaths';

import * as path from 'path';

export class TaskBuilder {
  private persistedTasks: PersistedTask[];

  /** Cache of previously computed diff stats, keyed by taskId */
  private diffStatCache = new Map<string, DiffStat>();

  /** Tracks the previous derived status per task for detecting transitions */
  private previousDerivedStatuses = new Map<string, TaskStatus>();

  /** External read-state resolver (backed by globalState) */
  private readStateResolver?: (taskId: string, updatedAt: number) => boolean;

  constructor(persistedTasks: PersistedTask[]) {
    this.persistedTasks = persistedTasks;
  }

  /**
   * Set an external resolver for isRead state (backed by globalState).
   */
  setReadStateResolver(resolver: (taskId: string, updatedAt: number) => boolean): void {
    this.readStateResolver = resolver;
  }

  /**
   * Update the persisted tasks reference (e.g. after reloading from disk).
   */
  updatePersistedTasks(tasks: PersistedTask[]): void {
    this.persistedTasks = tasks;
  }

  /**
   * Build the full task list by merging persisted tasks with live session data.
   *
   * For each persisted task:
   *   1. Find matching sessions by sessionIds (same-workspace) or worktree path
   *   2. Derive task status from session statuses
   *   3. Populate approvalPreview for waiting tasks
   *   4. Populate diffStat for review tasks (cached)
   *   5. Return merged list
   *
   * Orphan sessions (not linked to any task) are NOT included.
   */
  async buildTasks(
    projects: TowerProject[],
    sessions: Map<string, TowerSession[]>,
  ): Promise<TowerTask[]> {
    const tasks: TowerTask[] = [];

    for (const persisted of this.persistedTasks) {
      // Find matching sessions
      const matchedSessions = this.findMatchingSessions(persisted, sessions);

      // Derive status from sessions, but respect explicit done/backlog overrides
      let derivedStatus = this.deriveStatusFromSessions(matchedSessions);

      // If the persisted task was explicitly marked done, keep it done
      if (persisted.status === 'done') {
        derivedStatus = 'done';
      }
      // If persisted is backlog and there are no active sessions, keep it backlog
      if (persisted.status === 'backlog' && matchedSessions.length === 0) {
        derivedStatus = 'backlog';
      }

      // Build the task
      const task: TowerTask = {
        id: persisted.id,
        title: persisted.title,
        description: persisted.description,
        status: derivedStatus,
        source: persisted.source,
        mode: persisted.mode,
        linearIssueId: persisted.linearIssueId,
        linearIdentifier: persisted.linearIdentifier,
        linearIssueUrl: persisted.linearIssueUrl,
        projectPath: persisted.projectPath,
        worktreePath: persisted.worktreePath,
        branch: persisted.branch,
        activeSessionId: this.findActiveSessionId(matchedSessions),
        sessions: matchedSessions,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        isRead: this.computeIsRead(persisted.id, persisted.updatedAt, derivedStatus),
      };

      // Populate approvalPreview for waiting tasks
      if (derivedStatus === 'waiting') {
        task.approvalPreview = await this.getApprovalPreview(
          persisted,
          matchedSessions,
        );
      }

      // Populate diffStat for review tasks
      if (derivedStatus === 'review') {
        task.diffStat = await this.getDiffStat(persisted);
      }

      // Track derived status for next cycle's transition detection
      this.previousDerivedStatuses.set(persisted.id, derivedStatus);

      tasks.push(task);
    }

    return tasks;
  }

  /**
   * Determine if a task has been read. Uses external globalState resolver
   * if available, otherwise detects transitions from previous cycle.
   */
  private computeIsRead(taskId: string, updatedAt: number, currentStatus: TaskStatus): boolean {
    // If external resolver is available (backed by globalState), use it
    if (this.readStateResolver) {
      return this.readStateResolver(taskId, updatedAt);
    }

    // Fallback: detect transition to review/waiting — mark as unread
    const prevStatus = this.previousDerivedStatuses.get(taskId);
    if (prevStatus && prevStatus !== currentStatus) {
      if (currentStatus === 'review' || currentStatus === 'waiting') {
        return false; // Just transitioned — unread
      }
    }
    return true;
  }

  /**
   * Derive a TaskStatus from the statuses of associated sessions.
   *
   * Mapping:
   *   - No sessions -> backlog
   *   - Any session working or idle -> in-progress
   *   - Any session waiting -> waiting
   *   - All sessions done/error -> review
   */
  deriveStatusFromSessions(sessions: TowerSession[]): TaskStatus {
    if (sessions.length === 0) {
      return 'backlog';
    }

    const statuses = new Set(sessions.map((s) => s.status));

    // Priority order: waiting > working > idle > done/error
    if (statuses.has('waiting')) {
      return 'waiting';
    }

    if (statuses.has('working') || statuses.has('idle')) {
      return 'in-progress';
    }

    // All sessions are done or error
    return 'review';
  }

  /**
   * Find sessions that match a persisted task.
   *
   * For same-workspace mode: match by sessionIds stored on the task.
   * For worktree mode: match by worktree path (sessions in the same encoded project dir).
   */
  private findMatchingSessions(
    persisted: PersistedTask,
    sessions: Map<string, TowerSession[]>,
  ): TowerSession[] {
    const matched: TowerSession[] = [];

    // Flatten all sessions for lookup by ID
    const allSessions: TowerSession[] = [];
    for (const sessionList of sessions.values()) {
      allSessions.push(...sessionList);
    }

    if (persisted.sessionIds && persisted.sessionIds.length > 0) {
      // Match by explicit session IDs
      const idSet = new Set(persisted.sessionIds);
      for (const session of allSessions) {
        if (idSet.has(session.id)) {
          matched.push(session);
        }
      }
    }

    // For worktree mode with no explicit sessionIds, match all sessions
    // from the project's encoded directory (worktree sessions live under
    // the project's sessions dir, or under a worktree-specific encoded dir)
    if (
      persisted.mode === 'worktree' &&
      persisted.projectPath &&
      matched.length === 0
    ) {
      // Try matching by the project's encoded dir
      const encodedProject = encodeProjectPath(persisted.projectPath);
      const projectSessions = sessions.get(encodedProject);
      if (projectSessions) {
        matched.push(...projectSessions);
      }

      // Also try matching by the worktree's encoded dir (if different)
      if (persisted.worktreePath) {
        const encodedWorktree = encodeProjectPath(persisted.worktreePath);
        const worktreeSessions = sessions.get(encodedWorktree);
        if (worktreeSessions && encodedWorktree !== encodedProject) {
          matched.push(...worktreeSessions);
        }
      }
    }

    return matched;
  }

  /**
   * Find the most recently active session ID.
   */
  private findActiveSessionId(sessions: TowerSession[]): string | undefined {
    const active = sessions.filter(
      (s) => s.status === 'working' || s.status === 'waiting',
    );
    if (active.length > 0) {
      // Return the most recently updated
      active.sort((a, b) => b.updatedAt - a.updatedAt);
      return active[0].id;
    }
    return undefined;
  }

  /**
   * Extract the approval preview for a waiting task from its active session's JSONL.
   */
  private async getApprovalPreview(
    persisted: PersistedTask,
    sessions: TowerSession[],
  ): Promise<string | undefined> {
    // Find the waiting session
    const waitingSession = sessions.find((s) => s.status === 'waiting');
    if (!waitingSession || !persisted.projectPath) {
      return undefined;
    }

    try {
      const encodedProject = persisted.projectPath.replace(/\//g, '-');
      const sessionsDir = getSessionsDir(encodedProject);
      const sessionFile = path.join(sessionsDir, `${waitingSession.id}.jsonl`);

      const tailEvents = await readJsonlTail(sessionFile, 8192);
      return extractApprovalPreview(tailEvents);
    } catch {
      return undefined;
    }
  }

  /**
   * Get or compute diff stats for a task in review.
   * Results are cached per task ID.
   */
  private async getDiffStat(
    persisted: PersistedTask,
  ): Promise<DiffStat | undefined> {
    // Check cache
    const cached = this.diffStatCache.get(persisted.id);
    if (cached) {
      return cached;
    }

    if (!persisted.worktreePath || !persisted.branch) {
      return undefined;
    }

    const result = await computeDiffStat(
      persisted.worktreePath,
      persisted.projectPath,
      persisted.branch,
    );

    if (result) {
      this.diffStatCache.set(persisted.id, result);
    }

    return result;
  }
}
