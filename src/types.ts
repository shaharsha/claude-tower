// ============================================================
// CORE: Task is the atomic unit
// ============================================================

export interface TowerTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  source: 'linear' | 'manual';
  mode: 'worktree' | 'same-workspace';

  // Linear fields
  linearIssueId?: string;       // UUID for API calls
  linearIdentifier?: string;    // "TEN-42" for display
  linearIssueUrl?: string;
  linearLabels?: string[];
  linearPriority?: number;

  // Worktree binding
  projectPath?: string;
  worktreePath?: string;
  branch?: string;

  // Session binding
  activeSessionId?: string;
  sessions: TowerSession[];

  // Metadata
  createdAt: number;
  updatedAt: number;
  isRead: boolean;
  diffStat?: DiffStat;
  approvalPreview?: string;
}

export type TaskStatus =
  | 'backlog'
  | 'in-progress'
  | 'waiting'
  | 'review'
  | 'done';

export interface TowerSession {
  id: string;
  status: SessionStatus;
  statusSince: number;
  summary: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  lastAssistantMessage?: string;
  /** Timestamp of the last user message (for "running since" display) */
  lastUserMessageAt?: number;
  /** True if a Claude process with --resume for this session ID is alive */
  hasAliveProcess?: boolean;
}

export type SessionStatus =
  | 'working'
  | 'waiting'
  | 'done'
  | 'error'
  | 'idle';

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

// ============================================================
// PROJECT / WORKTREE
// ============================================================

export interface TowerProject {
  id: string;
  path: string;
  name: string;
  exists: boolean;
  worktrees: TowerWorktree[];
  linearTeamId?: string;
}

export interface TowerWorktree {
  path: string;
  branch: string;
  isMain: boolean;
  isCurrentWindow: boolean;
  hasOpenWindow: boolean;
  task?: TowerTask;
  sessions: TowerSession[];
}

// ============================================================
// LINEAR
// ============================================================

export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state: string;
  priority: number;
  labels: string[];
  assignee?: string;
  url: string;
  attachments: LinearAttachment[];
  acceptanceCriteria?: string;
}

export interface LinearAttachment {
  url: string;
  filename: string;
  mimeType: string;
}

export interface LinearConfig {
  teamId: string;
  projectId?: string;
  filter?: 'assigned' | 'all' | 'unassigned';
  statusMapping?: Record<string, string>;
  reverseStatusMapping?: Record<string, string>;
  branchPrefix?: string;
}

// ============================================================
// PERSISTENCE
// ============================================================

export interface TowerPersistedState {
  tasks: PersistedTask[];
  version: 1;
}

export interface PersistedTask {
  id: string;
  title: string;
  description?: string;
  source: 'linear' | 'manual';
  mode: 'worktree' | 'same-workspace';
  linearIssueId?: string;
  linearIdentifier?: string;
  linearIssueUrl?: string;
  branch?: string;
  worktreePath?: string;
  projectPath?: string;
  sessionIds: string[];
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

// ============================================================
// CONFIG
// ============================================================

export interface TowerConfig {
  linear?: LinearConfig;
  hooks?: {
    postCreate?: string;
    preArchive?: string;
  };
  copyFiles?: string[];
  symlinkDirs?: string[];
  worktreeDir?: string;
  pr?: {
    baseBranch?: string;
    draft?: boolean;
  };
}

// ============================================================
// STATE
// ============================================================

export interface TowerState {
  projects: TowerProject[];
  tasks: TowerTask[];
}

// ============================================================
// JSONL Events
// ============================================================

export interface JsonlEvent {
  type: string;
  sessionId?: string;
  timestamp?: string;
  role?: string;
  content?: any;
  toolName?: string;
  toolInput?: any;
  toolUseId?: string;
  tool_use_id?: string;
  durationMs?: number;
  summary?: string;
  duration?: number;
}
