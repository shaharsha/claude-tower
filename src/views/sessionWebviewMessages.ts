/** Data for a single session rendered in the webview */
export interface SessionItemData {
  id: string;
  summary: string;
  status: string;
  description: string;
  worktreePath: string;
  /** Show ship button */
  showShip: boolean;
  /** Show open-session arrow */
  showOpen: boolean;
  /** Unread session in To Review group */
  toReview?: boolean;
}

/** Data for a pending worktree */
export interface ReadyItemData {
  type: 'ready';
  worktreePath: string;
  branch: string;
  label: string;
  description: string;
}

/** Data for load-more button */
export interface LoadMoreData {
  type: 'loadMore';
  remaining: number;
}

/** A group of items to render */
export interface GroupData {
  name: string;
  count: number;
  icon: string;
  color: string;
  expanded: boolean;
  items: (SessionItemData | ReadyItemData | LoadMoreData)[];
}

// ── Extension → Webview ─────────────────────────────────────

export interface RenderMessage {
  type: 'render';
  groups: GroupData[];
  loading: boolean;
}

export interface TickMessage {
  type: 'tick';
  updates: { id: string; description: string }[];
}

export type ExtensionToWebview = RenderMessage | TickMessage;

// ── Webview → Extension ─────────────────────────────────────

export interface OpenSessionMessage {
  type: 'openSession';
  worktreePath: string;
  sessionId: string;
}

export interface ShipSessionMessage {
  type: 'shipSession';
  worktreePath: string;
  sessionId: string;
}

export interface RemoveWorktreeMessage {
  type: 'removeWorktree';
  worktreePath: string;
  label: string;
}

export interface NewSessionMessage {
  type: 'newSession';
  worktreePath: string;
}

export interface OpenWorktreeMessage {
  type: 'openWorktree';
  worktreePath: string;
}

export interface LoadMoreMessage {
  type: 'loadMore';
}

export interface MarkReadMessage {
  type: 'markRead';
  sessionId: string;
}

export type WebviewToExtension =
  | OpenSessionMessage
  | ShipSessionMessage
  | RemoveWorktreeMessage
  | NewSessionMessage
  | OpenWorktreeMessage
  | LoadMoreMessage
  | MarkReadMessage;
