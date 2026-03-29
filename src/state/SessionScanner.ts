import * as fs from 'fs';
import * as path from 'path';

import type { TowerSession, SessionStatus, JsonlEvent } from '../types';
import type { AliveProcessInfo } from './ProcessMonitor';
import { getSessionsDir, decodeProjectPath } from '../util/claudePaths';
import { readJsonlHead, readJsonlTail } from '../util/jsonlReader';
import { extractApprovalPreview } from '../util/approvalPreview';
import { readHookStatus } from './HooksManager';

/** Index entry from sessions-index.json */
interface SessionIndexEntry {
  sessionId: string;
  summary?: string;
  messageCount?: number;
}

export class SessionScanner {
  /**
   * Scan all session JSONL files for an encoded project directory.
   *
   * For each .jsonl file in the sessions/ dir:
   *   - Read stat for mtime
   *   - Read head (first 1KB) for session_start event (sessionId, timestamp)
   *   - Read tail (last 8KB) for status detection and last assistant message
   *   - Optionally read sessions-index.json for summaries
   *
   * @param encodedProjectDir  The encoded project directory name (e.g. "-Users-shahar-myproject")
   * @param aliveInfo          Info about running Claude processes (CWDs + session IDs)
   * @param resolvedPath       The actual filesystem path (handles hyphen-ambiguous encodings)
   */
  async scanSessions(
    encodedProjectDir: string,
    aliveInfo?: AliveProcessInfo,
    resolvedPath?: string,
  ): Promise<TowerSession[]> {
    const sessionsDir = getSessionsDir(encodedProjectDir);

    let files: string[];
    try {
      files = await fs.promises.readdir(sessionsDir);
    } catch {
      return [];
    }

    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) {
      return [];
    }

    // Optionally load session index for summaries
    const summaryMap = await this.loadSessionIndex(sessionsDir);

    const sessions: TowerSession[] = [];

    for (const file of jsonlFiles) {
      const filePath = path.join(sessionsDir, file);

      // Get file stat
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue;
      }

      // Read head for session metadata
      const headEvents = await readJsonlHead(filePath, 2048);

      // Session ID: from any event with sessionId, or from the filename
      const sessionId =
        headEvents.find((e) => e.sessionId)?.sessionId ??
        path.basename(file, '.jsonl');

      // Created timestamp: from first event, or file birthtime
      const firstTimestamp = headEvents.find((e) => e.timestamp)?.timestamp;
      const createdAt = firstTimestamp
        ? new Date(firstTimestamp as string).getTime()
        : stat.birthtimeMs;

      // Read tail for status detection
      const tailEvents = await readJsonlTail(filePath, 8192);

      // Detect status
      const status = this.detectSessionStatus(
        tailEvents,
        stat.mtimeMs,
        aliveInfo ?? { cwds: new Set(), sessionIds: new Set() },
        sessionsDir,
        resolvedPath,
        sessionId,
      );

      // Extract last assistant message from tail
      const lastAssistantMessage = this.extractLastAssistantMessage(tailEvents);

      // Extract last user message timestamp (for "running since" display)
      const lastUserMessageAt = this.extractLastUserMessageTime(tailEvents);

      // Get summary from index if available
      const indexEntry = summaryMap.get(sessionId);
      const summary = indexEntry?.summary ?? this.deriveSummary(headEvents, tailEvents);
      const messageCount = indexEntry?.messageCount ?? this.countMessages(tailEvents);

      // Determine statusSince: mtime of file is a reasonable proxy
      const statusSince = stat.mtimeMs;

      // Check if this specific session has an alive process (--resume match)
      const hasAliveProcess = sessionId
        ? (aliveInfo ?? { sessionIds: new Set() }).sessionIds.has(sessionId)
        : false;

      sessions.push({
        id: sessionId,
        status,
        statusSince,
        summary,
        messageCount,
        createdAt,
        updatedAt: stat.mtimeMs,
        lastAssistantMessage,
        lastUserMessageAt,
        hasAliveProcess,
      });
    }

    return sessions;
  }

  /**
   * Detect session status from tail events, file mtime, and process table.
   *
   * Real Claude Code JSONL has NO session_end event. Status is determined by:
   *   - Unresolved tool_use in assistant content → waiting for approval
   *   - Progress events or recent mtime + alive process → working
   *   - Last assistant has stop_reason:"end_turn" + not recent → done
   *   - system event with subtype:"api_error" → error
   *   - Otherwise → idle
   *
   * Assistant events are STREAMED as multiple chunks with the same message.id.
   * Only the last chunk of a response has stop_reason set.
   */
  detectSessionStatus(
    tailEvents: JsonlEvent[],
    mtimeMs: number,
    aliveInfo: AliveProcessInfo,
    sessionDir: string,
    resolvedPath?: string,
    sessionId?: string,
  ): SessionStatus {
    if (tailEvents.length === 0) {
      return 'idle';
    }

    // Process detection signals
    const isSessionAlive = sessionId
      ? aliveInfo.sessionIds.has(sessionId)
      : false;
    const isCwdAlive = this.isCwdAlive(aliveInfo.cwds, sessionDir, resolvedPath);
    const isRecent = Date.now() - mtimeMs < 30_000;

    // CPU-based: is the process ACTIVELY working (CPU > 1%)?
    // This is the most reliable signal — no JSONL heuristics needed.
    const isSessionActive = sessionId
      ? aliveInfo.activeSessionIds.has(sessionId)
      : false;
    const isCwdActive = this.isCwdAlive(aliveInfo.activeCwds, sessionDir, resolvedPath);

    // ── LAYER 1: Hook status (definitive, from Claude Code lifecycle events) ──
    // No time-based expiry — hooks are the ground truth. Verify process is
    // alive for "working"/"waiting" to catch crashes where Stop never fired.
    if (sessionId) {
      const hookStatus = readHookStatus(sessionId);
      if (hookStatus) {
        const hookAge = Date.now() - hookStatus.ts;

        if (hookStatus.status === 'working') {
          // Trust if process alive OR hook was updated recently (< 30s)
          if (isSessionAlive || hookAge < 30_000) { return 'working'; }
          // Process dead + hook stale → session crashed, fall through
        }
        if (hookStatus.status === 'waiting') {
          if (isSessionAlive || hookAge < 30_000) { return 'waiting'; }
        }
        if (hookStatus.status === 'idle') {
          if (hookAge < 5_000) {
            // Idle for < 5s — likely a brief inter-turn gap (Stop fires
            // between every tool call). Keep as "working" to avoid flicker.
            return 'working';
          }
          return 'done';
        }
      }
    }

    // 1. Check for API errors in the tail (after hooks — a recovered session overrides this)
    if (this.hasErrorIndicators(tailEvents)) {
      return 'error';
    }

    // ── LAYER 2: CPU-based (process actively using CPU) ──
    if (isSessionActive) {
      return 'working';
    }

    // ── LAYER 3: JSONL heuristics (fallback for sessions without hooks) ──

    // 3a. Awaiting response (user sent message recently, Claude thinking)
    //     Requires BOTH process alive AND recent file write — "alive" alone
    //     just means VS Code has the panel open.
    if ((isSessionAlive || isCwdAlive) && isRecent && this.isAwaitingResponse(tailEvents)) {
      return 'working';
    }

    // 3b. Recent writes + response not complete (streaming)
    if (isRecent && !this.isLastResponseComplete(tailEvents)) {
      return 'working';
    }

    // 3c. Recent writes + unresolved tool_use (tool executing)
    if (isRecent && this.hasUnresolvedToolUse(tailEvents)) {
      return 'working';
    }

    // 3d. CPU active in CWD + recent writes (agentic loop gaps)
    if (isCwdActive && isRecent) {
      return 'working';
    }

    // 4. Unresolved tool_use with NO recent activity → waiting for approval
    if (this.hasUnresolvedToolUse(tailEvents)) {
      return 'waiting';
    }

    // 4. Recent file modification — may still be finishing
    if (isRecent) {
      const hasProgress = tailEvents.some((e) => e.type === 'progress');
      if (hasProgress) {
        return 'working';
      }
      return 'idle';
    }

    // 5. Not recent, not alive — check completion signals
    //    Completion signals: last-prompt, pr-link, or last assistant with stop_reason:"end_turn"
    const lastEvent = tailEvents[tailEvents.length - 1];

    if (lastEvent.type === 'last-prompt' || lastEvent.type === 'pr-link') {
      return 'done';
    }

    // Find the last assistant chunk with a non-null stop_reason
    for (let i = tailEvents.length - 1; i >= 0; i--) {
      const e = tailEvents[i];
      if (e.type === 'assistant') {
        const stopReason = (e as any).message?.stop_reason;
        if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
          return 'done';
        }
        if (stopReason === 'tool_use') {
          // Last response ended with tool_use but no tool_result followed
          // This means the session stopped mid-execution (likely user closed it)
          return 'idle';
        }
        if (stopReason === null || stopReason === undefined) {
          // Streaming chunk without stop_reason — keep scanning
          continue;
        }
      }
    }

    // Fallback: if the last event is a system or file-history-snapshot, likely done
    if (lastEvent.type === 'system' || lastEvent.type === 'ai-title') {
      return 'done';
    }

    return 'idle';
  }

  /**
   * Check if the session ended with an error. Only flags error if the
   * very last meaningful event is an error — mid-session errors that
   * were recovered from are not flagged.
   */
  private hasErrorIndicators(events: JsonlEvent[]): boolean {
    // Walk backwards from the end to find the last meaningful event
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];

      // Skip non-meaningful events (progress, file-history-snapshot, queue-operation)
      if (event.type === 'progress' || event.type === 'file-history-snapshot' || event.type === 'queue-operation') {
        continue;
      }

      // If the last meaningful event is an api error, flag it
      if (event.type === 'system' && (event as any).subtype === 'api_error') {
        return true;
      }
      if (event.type === 'assistant' && (event as any).isApiErrorMessage) {
        return true;
      }

      // Any other event type means the session recovered — not an error
      return false;
    }
    return false;
  }

  /**
   * Check if there is an unresolved tool_use in the tail events.
   * Check for unresolved tool_use in the actual Claude Code JSONL format:
   *
   *   type:"assistant" → event.message.content[] has {type:"tool_use", id, name, input}
   *   type:"user"      → event.message.content[] has {type:"tool_result", tool_use_id}
   */
  private hasUnresolvedToolUse(events: JsonlEvent[]): boolean {
    // Only check the LAST assistant message's tool_use blocks.
    // Checking all events in the tail causes false positives when old
    // tool_use IDs have their tool_results outside the 8KB window.
    const lastToolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    // Walk backward to find the last assistant message with tool_use
    let foundLastAssistant = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      const msg = (event as any).message;
      const content = msg?.content ?? event.content;

      if (event.type === 'assistant' && !foundLastAssistant && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.id) {
            lastToolUseIds.add(block.id);
          }
        }
        if (lastToolUseIds.size > 0) {
          foundLastAssistant = true;
        }
      }

      // Collect ALL tool_results (they may come after the assistant message)
      if (event.type === 'user' && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultIds.add(block.tool_use_id);
          }
        }
      }

      // Standalone tool_result events (fallback)
      if (event.type === 'tool_result') {
        const id = (event as any).toolUseId ?? (event as any).tool_use_id ?? (event as any).id;
        if (id) { toolResultIds.add(id); }
      }
    }

    for (const id of lastToolUseIds) {
      if (!toolResultIds.has(id)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a Claude process is running in a directory related to the session.
   * The sessionDir is like ~/.claude/projects/-Users-foo-myproject/sessions/
   * We need to decode the project path and check against alive process cwds.
   */
  /**
   * Check if the last assistant response in the tail has completed (end_turn).
   * Skips system/progress events to find the last meaningful user or assistant event.
   * Returns true if Claude finished its turn and is waiting for user input.
   */
  private isLastResponseComplete(events: JsonlEvent[]): boolean {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      // Skip non-conversation events (system, progress, metadata)
      if (e.type !== 'user' && e.type !== 'assistant') {
        continue;
      }
      // User sent a message after the last assistant response — Claude should respond
      if (e.type === 'user') {
        return false;
      }
      // Last conversation event is an assistant message — check if it completed
      if (e.type === 'assistant') {
        const stopReason = (e as any).message?.stop_reason;
        return stopReason === 'end_turn' || stopReason === 'stop_sequence';
      }
    }
    return false;
  }

  /**
   * Check if the session is awaiting a response from Claude.
   * True if the last conversation event is a user message sent within 5 minutes.
   * This covers the "thinking gap" where Claude hasn't written anything yet.
   */
  private isAwaitingResponse(events: JsonlEvent[]): boolean {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type !== 'user' && e.type !== 'assistant') {
        continue;
      }
      if (e.type === 'user') {
        if (e.timestamp) {
          const msgTime = new Date(e.timestamp as string).getTime();
          return Date.now() - msgTime < 300_000;
        }
        return false; // No timestamp — can't verify recency, don't assume
      }
      // Last conversation event is assistant, not user
      return false;
    }
    return false;
  }

  /**
   * Check if any alive Claude process has a CWD matching this session's project.
   * Used as a fallback for new sessions that don't have --resume flags.
   */
  private isCwdAlive(
    aliveCwds: Set<string>,
    sessionDir: string,
    resolvedPath?: string,
  ): boolean {
    if (aliveCwds.size === 0) { return false; }

    const candidates: string[] = [];
    if (resolvedPath) {
      candidates.push(resolvedPath);
    }

    const encodedName = path.basename(sessionDir);
    const decodedPath = decodeProjectPath(encodedName);
    if (decodedPath !== resolvedPath) {
      candidates.push(decodedPath);
    }

    for (const cwd of aliveCwds) {
      for (const candidate of candidates) {
        if (cwd === candidate || cwd.startsWith(candidate + '/') || candidate.startsWith(cwd + '/')) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Extract the last assistant text message from tail events.
   */
  /**
   * Extract last assistant text message. Real format:
   *   { type: "assistant", message: { role: "assistant", content: [{type:"text",text:"..."}] } }
   */
  private extractLastAssistantMessage(events: JsonlEvent[]): string | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'assistant' || (event.type === 'message' && event.role === 'assistant')) {
        const content = (event as any).message?.content ?? event.content;
        if (typeof content === 'string') {
          return truncate(content, 200);
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              return truncate(block.text, 200);
            }
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Find the timestamp of the last user message in the tail events.
   * Used to show "running since X" for active sessions.
   */
  private extractLastUserMessageTime(events: JsonlEvent[]): number | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === 'user') {
        if (event.timestamp) {
          return new Date(event.timestamp as string).getTime();
        }
      }
    }
    return undefined;
  }

  /**
   * Load sessions-index.json if it exists. In Claude Code, this file
   * only exists at ~/.claude/projects/-/ (the root), not per-project.
   * Format: { version: 1, entries: [{ sessionId, fullPath, fileMtime, firstPrompt }] }
   */
  private async loadSessionIndex(
    projectDir: string,
  ): Promise<Map<string, SessionIndexEntry>> {
    const map = new Map<string, SessionIndexEntry>();

    // Try the project dir itself, then the root projects dir
    const candidates = [
      path.join(projectDir, 'sessions-index.json'),
      path.join(path.dirname(projectDir), '-', 'sessions-index.json'),
    ];

    for (const indexPath of candidates) {
      try {
        const raw = await fs.promises.readFile(indexPath, 'utf-8');
        const parsed = JSON.parse(raw);

        // Handle { version, entries: [...] } format
        const entries = parsed.entries ?? (Array.isArray(parsed) ? parsed : []);
        for (const entry of entries) {
          if (entry.sessionId) {
            map.set(entry.sessionId, {
              sessionId: entry.sessionId,
              summary: entry.firstPrompt ?? entry.summary,
              messageCount: entry.messageCount,
            });
          }
        }

        if (map.size > 0) { break; }
      } catch {
        // Index file doesn't exist or is invalid — that's fine
      }
    }

    return map;
  }

  /**
   * Derive a basic summary from the first user message or session start.
   */
  /**
   * Derive a summary from head events. Priority:
   *   1. ai-title event (Claude's auto-generated title)
   *   2. First user message text
   */
  private deriveSummary(
    headEvents: JsonlEvent[],
    _tailEvents: JsonlEvent[],
  ): string {
    // Check for ai-title event (generated by Claude Code)
    for (const event of headEvents) {
      if (event.type === 'ai-title' && (event as any).aiTitle) {
        return truncate((event as any).aiTitle, 120);
      }
    }

    // Look for the first user message
    for (const event of headEvents) {
      if (event.type === 'user' || (event.type === 'message' && event.role === 'user')) {
        const content = (event as any).message?.content ?? event.content;
        if (typeof content === 'string') {
          return truncate(content, 120);
        }
        if (Array.isArray(content)) {
          const text = content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join(' ');
          if (text) {
            return truncate(text, 120);
          }
        }
      }
    }

    return '';
  }

  /**
   * Estimate message count from tail events.
   * This is a rough count since we only have the tail.
   */
  private countMessages(events: JsonlEvent[]): number {
    let count = 0;
    for (const event of events) {
      if (event.type === 'message') {
        count++;
      }
    }
    return count;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen - 3) + '...';
}
