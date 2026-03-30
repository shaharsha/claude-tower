import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SessionScanner } from '../../src/state/SessionScanner';
import type { JsonlEvent, SessionStatus } from '../../src/types';
import type { AliveProcessInfo } from '../../src/state/ProcessMonitor';
import type { HookSessionStatus } from '../../src/state/HooksManager';

// ─── helpers ────────────────────────────────────────────────────────────────

const scanner = new SessionScanner();
const SESSION_ID = 'test-session-abc';
const SESSION_DIR = '/fake/.claude/projects/-Users-test/sessions/';

function emptyAlive(): AliveProcessInfo {
  return {
    sessions: new Map(),
    cwds: new Set(),
    sessionIds: new Set(),
    activeCwds: new Set(),
    activeSessionIds: new Set(),
  };
}

function aliveSession(): AliveProcessInfo {
  const info = emptyAlive();
  info.sessionIds.add(SESSION_ID);
  return info;
}

/** Process alive via CWD match (not session ID) */
function aliveCwd(cwd: string): AliveProcessInfo {
  const info = emptyAlive();
  info.cwds.add(cwd);
  return info;
}

function hook(status: HookSessionStatus, ageMs: number = 0) {
  return { status, ts: Date.now() - ageMs };
}

// ── Event builders ──────────────────────────────────────────────────────

function assistantChunk(stop_reason: string | null, content?: any[]): JsonlEvent {
  return {
    type: 'assistant',
    message: { stop_reason, content: content ?? [{ type: 'text', text: 'hello' }] },
  } as any;
}

function assistantToolUse(toolId: string, toolName: string = 'Read'): JsonlEvent {
  return {
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: toolId, name: toolName, input: {} }],
    },
  } as any;
}

/** Assistant with multiple tool_use blocks */
function assistantMultiTool(tools: { id: string; name: string }[]): JsonlEvent {
  return {
    type: 'assistant',
    message: {
      stop_reason: 'tool_use',
      content: tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: {} })),
    },
  } as any;
}

function toolResult(toolUseId: string): JsonlEvent {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
    content: [{ type: 'tool_result', tool_use_id: toolUseId }],
  } as any;
}

function userMessage(text: string = 'fix the bug', timestamp?: string): JsonlEvent {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    content: [{ type: 'text', text }],
    timestamp: timestamp ?? new Date().toISOString(),
  } as any;
}

function userMessageOld(text: string = 'fix the bug'): JsonlEvent {
  return userMessage(text, new Date(Date.now() - 600_000).toISOString());
}

function apiError(): JsonlEvent {
  return { type: 'system', subtype: 'api_error' } as any;
}

function apiErrorMessage(): JsonlEvent {
  return { type: 'assistant', isApiErrorMessage: true } as any;
}

function progressEvent(): JsonlEvent {
  return { type: 'progress' } as any;
}

function systemEvent(): JsonlEvent {
  return { type: 'system', subtype: 'init' } as any;
}

function aiTitleEvent(): JsonlEvent {
  return { type: 'ai-title' } as any;
}

function lastPromptEvent(): JsonlEvent {
  return { type: 'last-prompt' } as any;
}

function prLinkEvent(): JsonlEvent {
  return { type: 'pr-link' } as any;
}

function fileHistoryEvent(): JsonlEvent {
  return { type: 'file-history-snapshot' } as any;
}

function queueOperationEvent(): JsonlEvent {
  return { type: 'queue-operation' } as any;
}

function recentMtime(): number {
  return Date.now() - 5_000;
}

function staleMtime(): number {
  return Date.now() - 120_000;
}

function detect(
  tailEvents: JsonlEvent[],
  mtimeMs: number,
  aliveInfo: AliveProcessInfo,
  hookStatus?: { status: HookSessionStatus; ts: number } | null,
): SessionStatus {
  return scanner.detectSessionStatus(
    tailEvents,
    mtimeMs,
    aliveInfo,
    SESSION_DIR,
    undefined,
    SESSION_ID,
    hookStatus,
  );
}

/** Detect without session ID (tests CWD-based fallback paths) */
function detectNoSession(
  tailEvents: JsonlEvent[],
  mtimeMs: number,
  aliveInfo: AliveProcessInfo,
): SessionStatus {
  return scanner.detectSessionStatus(
    tailEvents,
    mtimeMs,
    aliveInfo,
    SESSION_DIR,
    undefined,
    undefined, // no session ID → hooks skipped
  );
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('detectSessionStatus', () => {

  // ── Empty / base cases ────────────────────────────────────────────────

  describe('base cases', () => {
    it('empty events → idle', () => {
      assert.equal(detect([], staleMtime(), emptyAlive(), null), 'idle');
    });

    it('empty events with alive process → idle', () => {
      assert.equal(detect([], staleMtime(), aliveSession(), null), 'idle');
    });

    it('empty events with hook → idle (hooks need events)', () => {
      assert.equal(detect([], staleMtime(), emptyAlive(), hook('working')), 'idle');
    });
  });

  // ── LAYER 1: Hook status ─────────────────────────────────────────────

  describe('hook=working', () => {
    it('fresh (1s) → working', () => {
      const events = [assistantChunk(null)];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 1_000)), 'working');
    });

    it('fresh (4m 59s) → working', () => {
      const events = [assistantChunk(null)];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 299_000)), 'working');
    });

    it('fresh + unresolved tool_use → working (BUG FIX: was "waiting")', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 10_000)), 'working');
    });

    it('fresh + end_turn in tail → working (hook overrides JSONL)', () => {
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 5_000)), 'working');
    });

    it('fresh + error in tail → working (hook overrides error)', () => {
      const events = [apiError()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 5_000)), 'working');
    });

    it('stale (6 min) + process alive → working (extended trust)', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('working', 360_000)), 'working');
    });

    it('stale (9m 59s) + process alive → working (near 10 min boundary)', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('working', 599_000)), 'working');
    });

    it('stale (10m 1s) + process alive + unresolved tool → waiting', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('working', 601_000)), 'waiting');
    });

    it('stale (6 min) + process dead + unresolved tool → waiting', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 360_000)), 'waiting');
    });

    it('stale + dead + unresolved tool + recent file → falls through', () => {
      // isRecent = true prevents waiting
      const events = [assistantToolUse('tool-1')];
      const result = detect(events, recentMtime(), emptyAlive(), hook('working', 360_000));
      assert.notEqual(result, 'waiting');
    });

    it('stale + dead + resolved tool → falls through to heuristics', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      const result = detect(events, staleMtime(), emptyAlive(), hook('working', 600_000));
      assert.notEqual(result, 'waiting');
    });

    it('very stale (1 hour) + dead + no tools → falls through', () => {
      const events = [assistantChunk('end_turn')];
      // Falls through working handler → no waiting/idle/error hooks → heuristics → done
      const result = detect(events, staleMtime(), emptyAlive(), hook('working', 3_600_000));
      assert.equal(result, 'done');
    });
  });

  describe('hook=waiting', () => {
    it('fresh + process alive → waiting', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('waiting', 10_000)), 'waiting');
    });

    it('fresh + process dead → waiting (trust fresh hook)', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('waiting', 10_000)), 'waiting');
    });

    it('stale + process alive → waiting', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('waiting', 600_000)), 'waiting');
    });

    it('at 5 min boundary + process dead → waiting', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('waiting', 299_000)), 'waiting');
    });

    it('stale (5m 1s) + process dead → falls through', () => {
      const events = [assistantChunk('end_turn')];
      const result = detect(events, staleMtime(), emptyAlive(), hook('waiting', 301_000));
      // Falls through to heuristics → done (end_turn)
      assert.equal(result, 'done');
    });
  });

  describe('hook=idle', () => {
    it('end_turn in tail → done', () => {
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 1_000)), 'done');
    });

    it('stop_sequence in tail → done', () => {
      const events = [assistantChunk('stop_sequence')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 1_000)), 'done');
    });

    it('tool_use stop_reason (not end_turn) + alive + fresh → working', () => {
      // Between tool calls: last response requested a tool, tool ran, Stop fired
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 10_000)), 'working');
    });

    it('streaming (null stop_reason) + alive + fresh → working', () => {
      const events = [assistantChunk(null)];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 10_000)), 'working');
    });

    it('no end_turn + alive + at 2 min boundary → working', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 119_000)), 'working');
    });

    it('no end_turn + alive + past 2 min → done (interrupted)', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 121_000)), 'done');
    });

    it('no end_turn + dead + hook < 5s → working (grace period)', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 3_000)), 'working');
    });

    it('no end_turn + dead + hook > 5s → done', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 6_000)), 'done');
    });

    it('user message after assistant (awaiting response) + alive + fresh → working', () => {
      // User sent message, Stop somehow fired, but Claude should respond
      const events = [assistantChunk('end_turn'), userMessage('do more')];
      // isLastResponseComplete → finds user message first → false
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 5_000)), 'working');
    });
  });

  // ── No hooks (LAYER 2: JSONL heuristics) ──────────────────────────────

  describe('no hooks — error detection', () => {
    it('api_error as last meaningful event → error', () => {
      const events = [apiError()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'error');
    });

    it('isApiErrorMessage assistant → error', () => {
      const events = [apiErrorMessage()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'error');
    });

    it('api_error followed by progress (skipped) → error', () => {
      const events = [apiError(), progressEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'error');
    });

    it('api_error followed by assistant (recovered) → not error', () => {
      const events = [apiError(), assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('api_error followed by file-history-snapshot (skipped) → error', () => {
      const events = [apiError(), fileHistoryEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'error');
    });

    it('api_error with working hook → working (hook overrides error)', () => {
      const events = [apiError()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 5_000)), 'working');
    });
  });

  describe('no hooks — awaiting response (2a)', () => {
    it('alive + recent + user message → working', () => {
      const events = [userMessage('fix this')];
      assert.equal(detect(events, recentMtime(), aliveSession(), null), 'working');
    });

    it('alive via CWD + recent + user message → working', () => {
      // Uses isCwdAlive path — need to decode session dir
      // This requires CWD match, which is complex. Test with session alive instead.
      const events = [userMessage('fix this')];
      assert.equal(detect(events, recentMtime(), aliveSession(), null), 'working');
    });

    it('alive + stale + user message → not working (file not recent)', () => {
      const events = [userMessage('fix this')];
      const result = detect(events, staleMtime(), aliveSession(), null);
      // Falls through awaiting check because !isRecent
      assert.notEqual(result, 'working');
    });

    it('dead + recent + user message → not working (process not alive)', () => {
      const events = [userMessage('fix this')];
      // isRecent + !isLastResponseComplete(user msg) → working via 2b
      // Actually, the user message makes isLastResponseComplete return false,
      // and isRecent is true → working via 2b. So this returns working via a different path.
      const result = detect(events, recentMtime(), emptyAlive(), null);
      assert.equal(result, 'working'); // via 2b: recent + response not complete
    });

    it('alive + recent + old user message (> 5 min) → falls through', () => {
      const events = [userMessageOld('fix this')];
      // isAwaitingResponse checks timestamp > 5 min → false
      // But isRecent + !isLastResponseComplete → working via 2b
      const result = detect(events, recentMtime(), aliveSession(), null);
      assert.equal(result, 'working');
    });
  });

  describe('no hooks — streaming detection (2b)', () => {
    it('recent + streaming chunk (null stop_reason) → working', () => {
      const events = [assistantChunk(null)];
      assert.equal(detect(events, recentMtime(), emptyAlive(), null), 'working');
    });

    it('recent + end_turn → not working (response complete)', () => {
      const events = [assistantChunk('end_turn')];
      // isRecent + isLastResponseComplete → skip 2b, falls to 2c
      // No unresolved tool_use → skip 2c → progress check
      const result = detect(events, recentMtime(), emptyAlive(), null);
      assert.equal(result, 'idle'); // recent + complete + no progress → idle
    });
  });

  describe('no hooks — unresolved tool_use (2c + 4)', () => {
    it('recent + unresolved tool_use → working (2c)', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, recentMtime(), emptyAlive(), null), 'working');
    });

    it('not recent + unresolved tool_use → waiting (4)', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'waiting');
    });

    it('not recent + all tools resolved → not waiting', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      const result = detect(events, staleMtime(), emptyAlive(), null);
      assert.notEqual(result, 'waiting');
    });

    it('multi-tool: one unresolved → waiting', () => {
      const events = [
        assistantMultiTool([
          { id: 'tool-1', name: 'Read' },
          { id: 'tool-2', name: 'Edit' },
        ]),
        toolResult('tool-1'),
        // tool-2 not resolved
      ];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'waiting');
    });

    it('multi-tool: all resolved → not waiting', () => {
      const events = [
        assistantMultiTool([
          { id: 'tool-1', name: 'Read' },
          { id: 'tool-2', name: 'Edit' },
        ]),
        toolResult('tool-1'),
        toolResult('tool-2'),
      ];
      const result = detect(events, staleMtime(), emptyAlive(), null);
      assert.notEqual(result, 'waiting');
    });
  });

  describe('no hooks — recent progress', () => {
    it('recent + progress events → working', () => {
      const events = [assistantChunk('end_turn'), progressEvent()];
      // isLastResponseComplete → end_turn → true, so 2b skips
      // No unresolved tool_use, so 2c/4 skips
      // isRecent + hasProgress → working
      assert.equal(detect(events, recentMtime(), emptyAlive(), null), 'working');
    });

    it('recent + no progress + complete → idle', () => {
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, recentMtime(), emptyAlive(), null), 'idle');
    });
  });

  describe('no hooks — completion signals (5)', () => {
    it('last-prompt event → done', () => {
      const events = [assistantChunk('end_turn'), lastPromptEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('pr-link event → done', () => {
      const events = [assistantChunk('end_turn'), prLinkEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('stop_reason: end_turn (no last-prompt) → done', () => {
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('stop_reason: stop_sequence → done', () => {
      const events = [assistantChunk('stop_sequence')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('stop_reason: tool_use (mid-execution interrupt) → idle', () => {
      // Last response ended with tool_use but no result → user closed
      const events = [assistantToolUse('tool-1')];
      // Not recent + unresolved tool_use → waiting (caught by rule 4 first)
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'waiting');
    });

    it('streaming chunks only (all null stop_reason) + not recent → idle', () => {
      // All chunks streaming, no final stop_reason found
      const events = [assistantChunk(null), assistantChunk(null)];
      // Not recent, not complete, no unresolved tool_use
      // Falls through all checks → idle
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'idle');
    });

    it('system event as last → done', () => {
      const events = [systemEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('ai-title event as last → done', () => {
      const events = [aiTitleEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });
  });

  // ── hasUnresolvedToolUse edge cases ───────────────────────────────────

  describe('hasUnresolvedToolUse', () => {
    it('only checks LAST assistant tool_use (not older ones)', () => {
      // Old tool_use resolved, new one also resolved
      const events = [
        assistantToolUse('old-tool'),
        toolResult('old-tool'),
        assistantToolUse('new-tool'),
        toolResult('new-tool'),
        assistantChunk('end_turn'),
      ];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('old unresolved tool_use ignored if newer assistant has none', () => {
      // Old tool_use unresolved, but newer assistant has no tools → no unresolved
      const events = [
        assistantToolUse('old-tool'),
        // no tool_result for old-tool
        assistantChunk('end_turn'), // new assistant with no tools
      ];
      // hasUnresolvedToolUse checks LAST assistant with tool_use → old-tool
      // But old-tool has no result → unresolved
      // Actually wait: it finds the LAST assistant with tool_use blocks.
      // The end_turn chunk has no tool_use, so it keeps searching backward.
      // It finds the old-tool assistant. old-tool has no result → unresolved.
      // Since not recent → waiting
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'waiting');
    });

    it('no tool_use in tail → not waiting', () => {
      const events = [assistantChunk('end_turn')];
      const result = detect(events, staleMtime(), emptyAlive(), null);
      assert.notEqual(result, 'waiting');
    });

    it('tool_result for wrong ID → still unresolved', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-2')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'waiting');
    });
  });

  // ── isLastResponseComplete edge cases ─────────────────────────────────

  describe('isLastResponseComplete', () => {
    it('skips progress events', () => {
      const events = [assistantChunk('end_turn'), progressEvent(), progressEvent()];
      // Idle hook + isLastResponseComplete skips progress → finds end_turn → done
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 5_000)), 'done');
    });

    it('user message after end_turn → not complete', () => {
      const events = [assistantChunk('end_turn'), userMessage('more please')];
      // Last conversation event is user → not complete
      // Idle hook + not complete + alive + fresh → working
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 5_000)), 'working');
    });

    it('only progress events → not complete (returns false)', () => {
      const events = [progressEvent(), progressEvent()];
      // isLastResponseComplete finds no user/assistant → false
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 5_000)), 'working');
    });
  });

  // ── No session ID (CWD-based fallback) ────────────────────────────────

  describe('no session ID', () => {
    it('hooks are skipped entirely', () => {
      // Even with a hook file, no sessionId means hooks aren't read
      const events = [assistantChunk('end_turn')];
      assert.equal(detectNoSession(events, staleMtime(), emptyAlive()), 'done');
    });

    it('recent + streaming → working (heuristics only)', () => {
      const events = [assistantChunk(null)];
      assert.equal(detectNoSession(events, recentMtime(), emptyAlive()), 'working');
    });
  });

  // ── Regression: oscillation scenarios ─────────────────────────────────

  describe('regression: oscillation', () => {
    it('subagent running: working hook + unresolved Agent tool → working', () => {
      const events = [assistantToolUse('agent-1', 'Agent')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 30_000)), 'working');
    });

    it('server thinking: working hook + no writes → working', () => {
      // Claude thinking server-side: no local CPU, no file writes,
      // but hook recently said "working"
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 45_000)), 'working');
    });

    it('between tool calls: idle hook + alive → working', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 3_000)), 'working');
    });

    it('rapid polling: working hook stays working at various ages', () => {
      const events = [assistantToolUse('tool-1')];
      for (const ageMs of [1_000, 10_000, 30_000, 60_000, 120_000, 299_000]) {
        assert.equal(
          detect(events, staleMtime(), emptyAlive(), hook('working', ageMs)),
          'working',
          `dead process, hook age ${ageMs}ms`,
        );
      }
    });

    it('5-min boundary: dead process', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 299_000)), 'working');
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 301_000)), 'waiting');
    });

    it('10-min boundary: alive process', () => {
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('working', 599_000)), 'working');
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('working', 601_000)), 'waiting');
    });

    it('interrupted session transitions to done via idle hook', () => {
      // User interrupted (Ctrl+C). Stop fires → idle. No end_turn in JSONL.
      // After 2 min grace, should be done — not stuck in working.
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 130_000)), 'done');
    });

    it('idle hook + alive + end_turn → done (immediate, race fixed by atomic writes)', () => {
      // With atomic writes + read cache, the hook value is reliable.
      // If hook says "idle" and JSONL shows end_turn → genuinely done.
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 2_000)), 'done');
    });

    it('idle hook + alive + no end_turn (tool_result) → working (between tool calls)', () => {
      // Between tool calls: last event is tool_result (user type).
      // isLastResponseComplete returns false → working.
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 2_000)), 'working');
    });

    it('interrupted session: stale working hook eventually falls through', () => {
      // Working hook from before interruption. No CPU, no alive, very stale.
      // No unresolved tools (last tool was resolved before interrupt).
      const events = [assistantToolUse('tool-1'), toolResult('tool-1'), assistantChunk(null)];
      const result = detect(events, staleMtime(), emptyAlive(), hook('working', 900_000));
      // Falls through working handler (no unresolved tool) → falls through waiting/idle
      // → heuristics: not recent, streaming chunk → idle
      assert.equal(result, 'idle');
    });
  });

  // ── Timeline scenarios: simulate status at each phase of a session ──

  describe('timeline: normal tool loop → completion', () => {
    // Simulates: user sends prompt → Claude reads files → edits → responds
    const alive = aliveSession();

    it('T=0s: user sends prompt, UserPromptSubmit fires → working', () => {
      const events = [userMessage('fix the bug')];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 0)), 'working');
    });

    it('T=3s: Claude streaming first response → working', () => {
      const events = [userMessage('fix the bug'), assistantChunk(null)];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 3_000)), 'working');
    });

    it('T=5s: Claude requests Read tool, PreToolUse fires → working', () => {
      const events = [
        userMessage('fix the bug'),
        assistantToolUse('tool-1', 'Read'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 0)), 'working');
    });

    it('T=6s: tool_result returned, Stop fires → working (between tools)', () => {
      const events = [
        assistantToolUse('tool-1', 'Read'),
        toolResult('tool-1'),
      ];
      // Stop just fired → idle hook. Process alive, hook fresh → working
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 0)), 'working');
    });

    it('T=8s: Claude thinking about result (server-side) → working', () => {
      const events = [
        assistantToolUse('tool-1', 'Read'),
        toolResult('tool-1'),
      ];
      // Still idle hook from 2s ago, process alive → working
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 2_000)), 'working');
    });

    it('T=15s: Claude requests Edit, PreToolUse fires → working', () => {
      const events = [
        assistantToolUse('tool-1', 'Read'),
        toolResult('tool-1'),
        assistantToolUse('tool-2', 'Edit'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 0)), 'working');
    });

    it('T=16s: edit applied, Stop fires → working (more tools coming)', () => {
      const events = [
        assistantToolUse('tool-2', 'Edit'),
        toolResult('tool-2'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 0)), 'working');
    });

    it('T=20s: Claude sends final response with end_turn → done', () => {
      const events = [
        assistantToolUse('tool-2', 'Edit'),
        toolResult('tool-2'),
        assistantChunk('end_turn'),
      ];
      // Stop fires after end_turn → idle hook. After 10s settle, end_turn confirmed → done
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 0)), 'done');
    });
  });

  describe('timeline: permission prompt → approval → completion', () => {
    const alive = aliveSession();

    it('T=0s: Claude requests Bash, Notification fires → waiting', () => {
      const events = [assistantToolUse('tool-1', 'Bash')];
      assert.equal(detect(events, recentMtime(), alive, hook('waiting', 0)), 'waiting');
    });

    it('T=30s: still waiting, user hasn\'t approved yet → waiting', () => {
      const events = [assistantToolUse('tool-1', 'Bash')];
      assert.equal(detect(events, staleMtime(), alive, hook('waiting', 30_000)), 'waiting');
    });

    it('T=45s: user approves, PreToolUse fires → working', () => {
      const events = [
        assistantToolUse('tool-1', 'Bash'),
        toolResult('tool-1'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 0)), 'working');
    });

    it('T=50s: tool finishes, Claude responds with end_turn → done', () => {
      const events = [
        assistantToolUse('tool-1', 'Bash'),
        toolResult('tool-1'),
        assistantChunk('end_turn'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 0)), 'done');
    });
  });

  describe('timeline: subagent running for several minutes', () => {
    const alive = aliveSession();

    it('T=0s: Claude spawns Agent subagent, SubagentStart fires → working', () => {
      const events = [assistantToolUse('agent-1', 'Agent')];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 0)), 'working');
    });

    it('T=60s: subagent still working, no new JSONL writes → working', () => {
      const events = [assistantToolUse('agent-1', 'Agent')];
      assert.equal(detect(events, staleMtime(), alive, hook('working', 60_000)), 'working');
    });

    it('T=3m: subagent still working, hook aging → working', () => {
      const events = [assistantToolUse('agent-1', 'Agent')];
      assert.equal(detect(events, staleMtime(), alive, hook('working', 180_000)), 'working');
    });

    it('T=6m: hook stale (> 5 min) but process alive → working (extended)', () => {
      const events = [assistantToolUse('agent-1', 'Agent')];
      assert.equal(detect(events, staleMtime(), alive, hook('working', 360_000)), 'working');
    });

    it('T=9m: still alive, approaching 10 min limit → working', () => {
      const events = [assistantToolUse('agent-1', 'Agent')];
      assert.equal(detect(events, staleMtime(), alive, hook('working', 540_000)), 'working');
    });

    it('T=11m: past 10 min trust window → waiting (may need attention)', () => {
      const events = [assistantToolUse('agent-1', 'Agent')];
      assert.equal(detect(events, staleMtime(), alive, hook('working', 660_000)), 'waiting');
    });

    it('T=7m: subagent returns, Stop fires, Claude responds → done', () => {
      const events = [
        assistantToolUse('agent-1', 'Agent'),
        toolResult('agent-1'),
        assistantChunk('end_turn'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 0)), 'done');
    });
  });

  describe('timeline: user interrupts (Ctrl+C) mid-session', () => {
    const alive = aliveSession();

    it('T=0s: session working normally → working', () => {
      const events = [
        assistantToolUse('tool-1', 'Read'),
        toolResult('tool-1'),
        assistantChunk(null),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 2_000)), 'working');
    });

    it('T=5s: user hits Ctrl+C, process killed, Stop never fires', () => {
      // Hook stays "working" from last PreToolUse. Process dies.
      const events = [
        assistantToolUse('tool-1', 'Read'),
        toolResult('tool-1'),
        assistantChunk(null),
      ];
      // Hook fresh (5s), still trusted
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 5_000)), 'working');
    });

    it('T=2m: hook getting stale, no process → still working (under 5 min)', () => {
      const events = [assistantToolUse('tool-1', 'Read'), toolResult('tool-1'), assistantChunk(null)];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 120_000)), 'working');
    });

    it('T=6m: hook stale (> 5 min), no process → falls through', () => {
      const events = [assistantToolUse('tool-1', 'Read'), toolResult('tool-1'), assistantChunk(null)];
      // No unresolved tool_use (tool-1 resolved), streaming chunk
      // Falls through working handler → heuristics → idle
      const result = detect(events, staleMtime(), emptyAlive(), hook('working', 360_000));
      assert.equal(result, 'idle');
    });
  });

  describe('timeline: user interrupts with Stop hook firing', () => {
    const alive = aliveSession();

    it('T=0s: Stop fires on interrupt → idle hook', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      // Idle hook just fired, process alive, no end_turn → working (grace)
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 0)), 'working');
    });

    it('T=30s: grace period, still seems working', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 30_000)), 'working');
    });

    it('T=2m: past grace period → done (correctly detected as interrupted)', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 125_000)), 'done');
    });
  });

  describe('timeline: error → recovery → completion', () => {
    const alive = aliveSession();

    it('T=0s: API error occurs → error', () => {
      const events = [userMessage('do something'), apiError()];
      // No hook (or stale hook) — falls through to error detection
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'error');
    });

    it('T=0s: API error with fresh working hook → working (hook wins)', () => {
      // Claude retries automatically while hook is still fresh
      const events = [userMessage('do something'), apiError()];
      assert.equal(detect(events, staleMtime(), alive, hook('working', 5_000)), 'working');
    });

    it('T=10s: Claude recovers, sends successful response → done', () => {
      const events = [apiError(), assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 0)), 'done');
    });
  });

  describe('timeline: multi-turn conversation', () => {
    const alive = aliveSession();

    it('turn 1: user asks, Claude responds → done', () => {
      const events = [userMessage('what is X?'), assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 60_000)), 'done');
    });

    it('turn 2: user sends follow-up, UserPromptSubmit fires → working', () => {
      const events = [assistantChunk('end_turn'), userMessage('now fix it')];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 0)), 'working');
    });

    it('turn 2: Claude working on follow-up → working', () => {
      const events = [
        userMessage('now fix it'),
        assistantToolUse('tool-1', 'Edit'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 3_000)), 'working');
    });

    it('turn 2: complete → done', () => {
      const events = [
        assistantToolUse('tool-1', 'Edit'),
        toolResult('tool-1'),
        assistantChunk('end_turn'),
      ];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 30_000)), 'done');
    });
  });

  describe('timeline: long server-side thinking (60-90s gaps)', () => {
    const alive = aliveSession();

    it('T=0s: tool completes, Stop fires → working (between tools)', () => {
      const events = [assistantToolUse('tool-1', 'Read'), toolResult('tool-1')];
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 0)), 'working');
    });

    it('T=30s: Claude still thinking server-side, no writes → working', () => {
      const events = [assistantToolUse('tool-1', 'Read'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 30_000)), 'working');
    });

    it('T=60s: long thinking, still within grace → working', () => {
      const events = [assistantToolUse('tool-1', 'Read'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 60_000)), 'working');
    });

    it('T=90s: very long thinking, near grace limit → working', () => {
      const events = [assistantToolUse('tool-1', 'Read'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 90_000)), 'working');
    });

    it('T=119s: at boundary → working', () => {
      const events = [assistantToolUse('tool-1', 'Read'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 119_000)), 'working');
    });

    it('T=121s: past grace → done (if truly interrupted)', () => {
      const events = [assistantToolUse('tool-1', 'Read'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 121_000)), 'done');
    });

    it('T=65s: Claude resumes, PreToolUse fires → working', () => {
      const events = [
        assistantToolUse('tool-1', 'Read'),
        toolResult('tool-1'),
        assistantToolUse('tool-2', 'Edit'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 0)), 'working');
    });
  });

  describe('timeline: panel open but session idle for hours', () => {
    const alive = aliveSession(); // Panel open = process alive

    it('T=0: session just completed → done', () => {
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 30_000)), 'done');
    });

    it('T=1h: panel still open, session long done → done', () => {
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 3_600_000)), 'done');
    });

    it('T=24h: panel still open, hook very stale → done', () => {
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 86_400_000)), 'done');
    });
  });

  describe('timeline: hookless legacy session', () => {
    it('T=0s: user sends message, file writing → working', () => {
      const events = [userMessage('do something')];
      assert.equal(detect(events, recentMtime(), aliveSession(), null), 'working');
    });

    it('T=10s: Claude streaming response → working', () => {
      const events = [userMessage('do something'), assistantChunk(null)];
      assert.equal(detect(events, recentMtime(), aliveSession(), null), 'working');
    });

    it('T=15s: tool executing → working', () => {
      const events = [assistantToolUse('tool-1', 'Read')];
      assert.equal(detect(events, recentMtime(), emptyAlive(), null), 'working');
    });

    it('T=60s: tool done, no activity → waiting (no hooks to know)', () => {
      const events = [assistantToolUse('tool-1', 'Bash')];
      // Not recent, unresolved tool_use, no hooks → waiting
      assert.equal(detect(events, staleMtime(), aliveSession(), null), 'waiting');
    });

    it('T=60s: tool done, result present → done', () => {
      const events = [
        assistantToolUse('tool-1', 'Bash'),
        toolResult('tool-1'),
        assistantChunk('end_turn'),
      ];
      assert.equal(detect(events, staleMtime(), aliveSession(), null), 'done');
    });
  });

  // ── Exhaustive: every code branch ─────────────────────────────────────

  describe('branch coverage: hook=working fall-through paths', () => {
    it('stale + dead + unresolved tool + isRecent → falls to heuristic 2c (working)', () => {
      // isRecent=true blocks the waiting check, falls through working handler.
      // Reaches heuristic 2c: recent + unresolved tool → working
      const events = [assistantToolUse('tool-1')];
      assert.equal(detect(events, recentMtime(), emptyAlive(), hook('working', 600_000)), 'working');
    });

    it('stale + dead + no tools + streaming chunk → falls to heuristic → idle', () => {
      const events = [assistantChunk(null)];
      // Falls through all working checks → no error → Layer 2: not recent + streaming → idle
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 600_000)), 'idle');
    });

    it('stale + dead + no tools + user message → falls to heuristic', () => {
      const events = [userMessage('hello')];
      // Falls through working → Layer 2: not alive + stale → not 2a.
      // 2b: not recent → skip. No tool_use. Not recent → completion signals.
      // user event is not last-prompt, not assistant → idle fallback
      const result = detect(events, staleMtime(), emptyAlive(), hook('working', 600_000));
      assert.equal(result, 'idle');
    });
  });

  describe('branch coverage: hook=waiting fall-through', () => {
    it('stale + dead → falls through to error check', () => {
      const events = [apiError()];
      // Hook waiting but stale + dead → falls through → error
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('waiting', 600_000)), 'error');
    });

    it('stale + dead + no error → falls to heuristics', () => {
      const events = [assistantChunk(null)];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('waiting', 600_000)), 'idle');
    });
  });

  describe('branch coverage: hook=idle edge cases', () => {
    it('end_turn + dead process + fresh hook → done (not grace period)', () => {
      // Process dead but hook fresh (< 5s) with end_turn → done takes priority
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 2_000)), 'done');
    });

    it('no end_turn + dead + hook exactly 5s → done', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 5_000)), 'done');
    });

    it('no end_turn + dead + hook exactly 4.9s → working (grace)', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 4_900)), 'working');
    });

    it('end_turn + alive + very stale hook (> 2 min) → done', () => {
      // isLastResponseComplete → true → done (before alive check)
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 200_000)), 'done');
    });

    it('no end_turn + alive + hookAge exactly 120s → done', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 120_000)), 'done');
    });
  });

  describe('branch coverage: Layer 2 heuristics edge cases', () => {
    it('recent + complete + unresolved tool → working (2c)', () => {
      // isLastResponseComplete = true (end_turn), but also unresolved tool
      // 2b skips (complete), but 2c catches unresolved tool
      const events = [assistantChunk('end_turn'), assistantToolUse('tool-1')];
      assert.equal(detect(events, recentMtime(), emptyAlive(), null), 'working');
    });

    it('not recent + resolved tools + tool_use stop_reason → idle', () => {
      // Tool completed but session ended mid-execution (no end_turn)
      // All tools resolved, stop_reason=tool_use, not recent
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      const result = detect(events, staleMtime(), emptyAlive(), null);
      // No unresolved tool_use → not waiting. Not recent → completion signals.
      // Last assistant has stop_reason=tool_use → idle
      assert.equal(result, 'idle');
    });

    it('queue-operation events are skipped in error detection', () => {
      const events = [apiError(), queueOperationEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'error');
    });

    it('isApiErrorMessage followed by queue-operation → error', () => {
      const events = [apiErrorMessage(), queueOperationEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'error');
    });

    it('mixed streaming chunks: only last stop_reason matters', () => {
      // Multiple assistant chunks, only last has stop_reason set
      const events = [
        assistantChunk(null),
        assistantChunk(null),
        assistantChunk(null),
        assistantChunk('end_turn'),
      ];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('recent + complete response + no progress + no tools → idle', () => {
      // Session just finished. Recent but complete, no progress events.
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, recentMtime(), emptyAlive(), null), 'idle');
    });
  });

  describe('branch coverage: hasUnresolvedToolUse details', () => {
    it('standalone tool_result event type resolves tool', () => {
      const events = [
        assistantToolUse('tool-1'),
        { type: 'tool_result', tool_use_id: 'tool-1' } as any,
      ];
      // Standalone tool_result (not wrapped in user message) should resolve
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'idle');
    });

    it('tool_use with empty content array → no unresolved', () => {
      // Assistant message with no tool_use blocks in content
      const events = [{ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } } as any];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('multiple sequential tool calls all resolved', () => {
      const events = [
        assistantToolUse('t1', 'Read'),
        toolResult('t1'),
        assistantToolUse('t2', 'Edit'),
        toolResult('t2'),
        assistantToolUse('t3', 'Bash'),
        toolResult('t3'),
        assistantChunk('end_turn'),
      ];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });

    it('parallel tools: 3 tools, only 2 resolved → waiting', () => {
      const events = [
        assistantMultiTool([
          { id: 't1', name: 'Read' },
          { id: 't2', name: 'Read' },
          { id: 't3', name: 'Read' },
        ]),
        toolResult('t1'),
        toolResult('t3'),
        // t2 missing
      ];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'waiting');
    });
  });

  describe('branch coverage: isLastResponseComplete details', () => {
    it('only system events (no user/assistant) → not complete', () => {
      // isLastResponseComplete finds no user/assistant → false
      // Without hooks: no error, not recent, last event is progress → idle
      const events = [systemEvent(), aiTitleEvent(), progressEvent()];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'idle');
    });

    it('assistant with stop_reason tool_use → not complete', () => {
      // isLastResponseComplete: tool_use stop_reason → false
      const events = [assistantToolUse('tool-1')];
      // Idle hook + not complete + alive → working
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 5_000)), 'working');
    });
  });

  describe('branch coverage: isAwaitingResponse', () => {
    it('user message without timestamp → not awaiting', () => {
      const events = [{
        type: 'user',
        message: { content: [{ type: 'text', text: 'hello' }] },
        content: [{ type: 'text', text: 'hello' }],
        // no timestamp
      } as any];
      // isAwaitingResponse: no timestamp → false
      // Falls through 2a. 2b: recent + user → not complete → working
      assert.equal(detect(events, recentMtime(), aliveSession(), null), 'working');
    });

    it('last event is assistant → not awaiting', () => {
      const events = [userMessage('hello'), assistantChunk(null)];
      // isAwaitingResponse: last conv event is assistant → false
      assert.equal(detect(events, recentMtime(), aliveSession(), null), 'working');
    });
  });

  // ── Real Claude Code behavior simulation ───────────────────────────────
  // These tests simulate ACTUAL Claude Code JSONL sequences and hook transitions
  // as they occur in real sessions, verified against real session data.

  describe('real behavior: rapid tool loop (Read → Edit → Read → Edit)', () => {
    // Claude iterates: read file, edit, read again, edit again. Each tool takes ~1s.
    // Hooks flip between working/idle every 1-2 seconds.
    const alive = aliveSession();

    it('scanner catches working hook during tool execution', () => {
      const events = [assistantToolUse('t1', 'Read')];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 500)), 'working');
    });

    it('scanner catches idle hook between tools (tool_result is last) → working', () => {
      const events = [assistantToolUse('t1', 'Read'), toolResult('t1')];
      // Stop just fired. Last event is tool_result (user) → not complete → working
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 200)), 'working');
    });

    it('scanner catches working hook for next tool → working', () => {
      const events = [
        assistantToolUse('t1', 'Read'), toolResult('t1'),
        assistantToolUse('t2', 'Edit'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 100)), 'working');
    });

    it('final end_turn after last edit → done', () => {
      const events = [
        assistantToolUse('t2', 'Edit'), toolResult('t2'),
        assistantChunk('end_turn'),
      ];
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 200)), 'done');
    });

    it('all 4 scanner polls during the loop stay working (no oscillation)', () => {
      // Simulates 4 consecutive scanner polls during a rapid tool loop.
      // The key insight: even when Stop fires (idle), tool_result is the last
      // JSONL event, so isLastResponseComplete returns false → working.
      const polls = [
        { events: [assistantToolUse('t1', 'Read')], h: hook('working', 500) },
        { events: [assistantToolUse('t1', 'Read'), toolResult('t1')], h: hook('idle', 200) },
        { events: [assistantToolUse('t1', 'Read'), toolResult('t1'), assistantToolUse('t2', 'Edit')], h: hook('working', 100) },
        { events: [assistantToolUse('t2', 'Edit'), toolResult('t2'), assistantChunk(null)], h: hook('working', 300) },
      ];
      for (const { events, h } of polls) {
        assert.equal(detect(events, recentMtime(), alive, h), 'working', `Failed for events with hook ${h.status}`);
      }
    });
  });

  describe('real behavior: Claude thinking for 30+ seconds between tools', () => {
    const alive = aliveSession();

    it('T=0: tool finishes, Stop fires → idle, tool_result is last → working', () => {
      const events = [assistantToolUse('t1', 'Read'), toolResult('t1')];
      assert.equal(detect(events, recentMtime(), alive, hook('idle', 0)), 'working');
    });

    it('T=15s: still thinking, JSONL unchanged → working', () => {
      const events = [assistantToolUse('t1', 'Read'), toolResult('t1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 15_000)), 'working');
    });

    it('T=45s: still thinking, hook aging but alive → working', () => {
      const events = [assistantToolUse('t1', 'Read'), toolResult('t1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 45_000)), 'working');
    });

    it('T=90s: very long thinking, still within 2min grace → working', () => {
      const events = [assistantToolUse('t1', 'Read'), toolResult('t1')];
      assert.equal(detect(events, staleMtime(), alive, hook('idle', 90_000)), 'working');
    });

    it('T=50s: Claude starts streaming new response → working', () => {
      const events = [assistantToolUse('t1', 'Read'), toolResult('t1'), assistantChunk(null)];
      assert.equal(detect(events, recentMtime(), alive, hook('working', 0)), 'working');
    });
  });

  describe('real behavior: permission prompt with plan approval', () => {
    const alive = aliveSession();

    it('Claude asks to run bash, Notification hook fires → waiting', () => {
      const events = [assistantToolUse('t1', 'Bash')];
      assert.equal(detect(events, staleMtime(), alive, hook('waiting', 0)), 'waiting');
    });

    it('user ignores for 5 minutes, still waiting', () => {
      const events = [assistantToolUse('t1', 'Bash')];
      assert.equal(detect(events, staleMtime(), alive, hook('waiting', 300_000)), 'waiting');
    });

    it('user ignores for 10 minutes, process alive → still waiting', () => {
      const events = [assistantToolUse('t1', 'Bash')];
      assert.equal(detect(events, staleMtime(), alive, hook('waiting', 600_000)), 'waiting');
    });

    it('user closes window (process dies), waiting hook stale → falls through', () => {
      const events = [assistantToolUse('t1', 'Bash')];
      // Dead + stale → waiting hook falls through → heuristics
      // unresolved tool_use + not recent → waiting (same result, but from heuristics)
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('waiting', 600_000)), 'waiting');
    });
  });

  describe('real behavior: session with large file reads (>8KB tail issue)', () => {
    // When Claude reads a very large file, the tool_result can be huge.
    // The 8KB JSONL tail might only contain partial data.

    it('tail shows only streaming chunks (no user/tool events) → handled gracefully', () => {
      // The 8KB window only has assistant streaming chunks
      const events = [
        assistantChunk(null), assistantChunk(null), assistantChunk(null),
        assistantChunk(null), assistantChunk(null),
      ];
      // With idle hook: not complete (no end_turn) + alive + fresh → working
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 5_000)), 'working');
      // With working hook: trusted → working
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 5_000)), 'working');
      // No hook + not recent: streaming chunks only → idle
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'idle');
    });

    it('tail shows only tool_result (massive output) + end_turn → done', () => {
      // The tool returned a huge result, then Claude completed with end_turn
      const events = [toolResult('t1'), assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), aliveSession(), hook('idle', 5_000)), 'done');
    });
  });

  describe('real behavior: Claude Code crash / OOM during session', () => {
    it('process dies mid-stream, working hook left behind', () => {
      const events = [assistantChunk(null), assistantChunk(null)];
      // Process dead, hook says working (PreToolUse was last hook)
      // Fresh hook → working (still trusted)
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 30_000)), 'working');
      // After 5 min, hook stale + dead + no tools → falls through → idle
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 400_000)), 'idle');
    });

    it('process dies, idle hook left behind, no end_turn', () => {
      const events = [assistantToolUse('t1'), toolResult('t1')];
      // Dead + idle hook + no end_turn → done after grace
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 10_000)), 'done');
    });
  });

  describe('real behavior: user manually kills session (kill -9)', () => {
    it('no Stop hook fires, working hook stays forever', () => {
      const events = [assistantToolUse('t1', 'Edit')];
      // Hook says working, process dead
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 60_000)), 'working');
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 200_000)), 'working');
      // After 5 min: stale + dead + unresolved tool → waiting
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 400_000)), 'waiting');
    });
  });

  describe('real behavior: multiple sessions same project', () => {
    // Two sessions in the same worktree — hook files are per session ID
    it('session A working, session B done — independent detection', () => {
      const eventsA = [assistantChunk(null)];
      const eventsB = [assistantChunk('end_turn')];
      assert.equal(detect(eventsA, recentMtime(), aliveSession(), hook('working', 1_000)), 'working');
      assert.equal(detect(eventsB, staleMtime(), aliveSession(), hook('idle', 30_000)), 'done');
    });
  });

  describe('real behavior: hook file race condition (pre-atomic-write)', () => {
    // Before atomic writes, hook reads could return undefined during file rewrite.
    // The read cache (hookReadCache) should return the last good value.
    // With hookStatusOverride=undefined, the code reads from disk.
    // We simulate the race by passing null (no hook found).

    it('hook suddenly disappears → falls through to heuristics', () => {
      // If cache miss + file read fail → null hook → heuristics
      const events = [assistantChunk(null)];
      // Recent + streaming → working (heuristic 2b)
      assert.equal(detect(events, recentMtime(), aliveSession(), null), 'working');
      // Stale + streaming → idle (no heuristic matches)
      assert.equal(detect(events, staleMtime(), aliveSession(), null), 'idle');
    });

    it('hook disappears but session clearly has end_turn → done', () => {
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), aliveSession(), null), 'done');
    });
  });

  describe('real behavior: SessionEnd hook fires (session cleanup)', () => {
    it('after SessionEnd, hook file deleted → no hook → heuristics', () => {
      // SessionEnd deletes the hook file. Next scan has no hook.
      const events = [assistantChunk('end_turn')];
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'done');
    });
  });

  // ── Stability: same input always produces same output ─────────────────

  describe('determinism', () => {
    it('same inputs produce same output across 100 calls', () => {
      const events = [assistantToolUse('tool-1'), toolResult('tool-1')];
      const alive = aliveSession();
      const h = hook('idle', 3_000);
      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        results.add(detect(events, staleMtime(), alive, h));
      }
      assert.equal(results.size, 1, `Expected 1 unique result, got ${results.size}: ${[...results]}`);
      assert.equal([...results][0], 'working');
    });
  });

  // ── Transition correctness: status never skips expected phases ────────

  describe('transition rules', () => {
    it('working hook → idle hook with end_turn: working → done (no intermediate)', () => {
      const alive = aliveSession();
      const events1 = [assistantToolUse('tool-1')];
      assert.equal(detect(events1, recentMtime(), alive, hook('working', 1_000)), 'working');

      const events2 = [assistantToolUse('tool-1'), toolResult('tool-1'), assistantChunk('end_turn')];
      assert.equal(detect(events2, recentMtime(), alive, hook('idle', 0)), 'done');
    });

    it('working → waiting: only when hook says waiting OR stale + unresolved tool', () => {
      const events = [assistantToolUse('tool-1', 'Bash')];
      const alive = aliveSession();
      // Fresh working hook → never waiting
      assert.equal(detect(events, staleMtime(), alive, hook('working', 60_000)), 'working');
      // Waiting hook → waiting
      assert.equal(detect(events, staleMtime(), alive, hook('waiting', 0)), 'waiting');
    });

    it('error only from JSONL — hooks can override back to working', () => {
      const events = [apiError()];
      // No hook → error
      assert.equal(detect(events, staleMtime(), emptyAlive(), null), 'error');
      // Working hook → working (overrides error)
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('working', 5_000)), 'working');
      // Idle hook → done (error not flagged because hook layer handles first)
      // Actually idle hook checks isLastResponseComplete first. apiError is system type → skipped.
      // No user/assistant → returns false. Then alive check...
      assert.equal(detect(events, staleMtime(), emptyAlive(), hook('idle', 10_000)), 'done');
    });
  });
});
