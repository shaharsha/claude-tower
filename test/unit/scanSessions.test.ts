import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SessionScanner } from '../../src/state/SessionScanner';

/**
 * Tests for scanSessions file filtering.
 *
 * Creates a temporary directory structure mimicking Claude Code's session layout
 * with both regular sessions and agent-* subagent files.
 */

let tmpDir: string;
let sessionsDir: string;

function writeJsonl(filename: string, events: any[]): void {
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(sessionsDir, filename), content);
}

function makeSessionStart(sessionId: string): any {
  return {
    type: 'system',
    subtype: 'init',
    sessionId,
    timestamp: new Date().toISOString(),
  };
}

function makeUserMessage(text: string): any {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
  };
}

function makeAssistantEnd(): any {
  return {
    type: 'assistant',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
    },
  };
}

describe('scanSessions', () => {
  const scanner = new SessionScanner();
  const emptyAlive = {
    sessions: new Map(),
    cwds: new Set<string>(),
    sessionIds: new Set<string>(),
    activeCwds: new Set<string>(),
    activeSessionIds: new Set<string>(),
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tower-test-'));
    sessionsDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes regular session JSONL files', async () => {
    writeJsonl('abc12345-1111-2222-3333-444444444444.jsonl', [
      makeSessionStart('abc12345-1111-2222-3333-444444444444'),
      makeUserMessage('fix the bug'),
      makeAssistantEnd(),
    ]);

    const sessions = await scanner.scanSessions(
      'test-project',
      emptyAlive,
      undefined,
      sessionsDir,
    );

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'abc12345-1111-2222-3333-444444444444');
  });

  it('EXCLUDES agent-* subagent JSONL files', async () => {
    // Regular session
    writeJsonl('abc12345-1111-2222-3333-444444444444.jsonl', [
      makeSessionStart('abc12345-1111-2222-3333-444444444444'),
      makeUserMessage('fix the bug'),
      makeAssistantEnd(),
    ]);

    // Subagent sessions — these should be filtered out
    writeJsonl('agent-a56faf.jsonl', [
      makeSessionStart('agent-a56faf'),
      makeUserMessage('subagent task'),
      makeAssistantEnd(),
    ]);
    writeJsonl('agent-a3285c.jsonl', [
      makeSessionStart('agent-a3285c'),
      makeUserMessage('another subagent'),
    ]);

    const sessions = await scanner.scanSessions(
      'test-project',
      emptyAlive,
      undefined,
      sessionsDir,
    );

    assert.equal(sessions.length, 1, `Expected 1 session, got ${sessions.length}: ${sessions.map((s) => s.id)}`);
    assert.equal(sessions[0].id, 'abc12345-1111-2222-3333-444444444444');
  });

  it('handles directory with only agent-* files (empty result)', async () => {
    writeJsonl('agent-abc123.jsonl', [
      makeSessionStart('agent-abc123'),
      makeUserMessage('subagent only'),
    ]);

    const sessions = await scanner.scanSessions(
      'test-project',
      emptyAlive,
      undefined,
      sessionsDir,
    );

    assert.equal(sessions.length, 0);
  });

  it('handles empty directory', async () => {
    const sessions = await scanner.scanSessions(
      'test-project',
      emptyAlive,
      undefined,
      sessionsDir,
    );

    assert.equal(sessions.length, 0);
  });

  it('ignores non-jsonl files', async () => {
    fs.writeFileSync(path.join(sessionsDir, 'sessions-index.json'), '{}');
    fs.writeFileSync(path.join(sessionsDir, '.DS_Store'), '');

    writeJsonl('abc12345-1111-2222-3333-444444444444.jsonl', [
      makeSessionStart('abc12345-1111-2222-3333-444444444444'),
      makeUserMessage('hello'),
      makeAssistantEnd(),
    ]);

    const sessions = await scanner.scanSessions(
      'test-project',
      emptyAlive,
      undefined,
      sessionsDir,
    );

    assert.equal(sessions.length, 1);
  });

  it('multiple regular sessions are all included', async () => {
    for (const id of ['aaa11111', 'bbb22222', 'ccc33333']) {
      const fullId = `${id}-1111-2222-3333-444444444444`;
      writeJsonl(`${fullId}.jsonl`, [
        makeSessionStart(fullId),
        makeUserMessage(`task for ${id}`),
        makeAssistantEnd(),
      ]);
    }

    const sessions = await scanner.scanSessions(
      'test-project',
      emptyAlive,
      undefined,
      sessionsDir,
    );

    assert.equal(sessions.length, 3);
  });

  it('mixed regular + agent sessions: only regular included', async () => {
    writeJsonl('real-sess-1111-2222-3333-444444444444.jsonl', [
      makeSessionStart('real-sess-1111-2222-3333-444444444444'),
      makeUserMessage('real task'),
      makeAssistantEnd(),
    ]);
    writeJsonl('agent-x1y2z3.jsonl', [
      makeSessionStart('agent-x1y2z3'),
    ]);
    writeJsonl('another-1111-2222-3333-444444444444.jsonl', [
      makeSessionStart('another-1111-2222-3333-444444444444'),
      makeUserMessage('another real task'),
      makeAssistantEnd(),
    ]);
    writeJsonl('agent-abcdef.jsonl', [
      makeSessionStart('agent-abcdef'),
    ]);

    const sessions = await scanner.scanSessions(
      'test-project',
      emptyAlive,
      undefined,
      sessionsDir,
    );

    const ids = sessions.map((s) => s.id);
    assert.equal(sessions.length, 2);
    assert.ok(ids.includes('real-sess-1111-2222-3333-444444444444'));
    assert.ok(ids.includes('another-1111-2222-3333-444444444444'));
    assert.ok(!ids.some((id) => id.startsWith('agent-')));
  });
});
