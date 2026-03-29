/**
 * Smoke test: exercises core modules against real ~/.claude/projects/ data.
 * Run with: node test/smoke.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ─── Test 1: claudePaths ───

console.log('\n── claudePaths ──');

// Decode
function decodeProjectPath(encoded) {
  let decoded = encoded;
  if (decoded.startsWith('-')) decoded = '/' + decoded.slice(1);
  decoded = decoded.replace(/-/g, '/');
  return decoded;
}

function getSessionsDir(encodedProject) {
  return join(PROJECTS_DIR, encodedProject);
}

const entries = readdirSync(PROJECTS_DIR);
assert(entries.length > 0, `Found ${entries.length} project directories`);

// Test naive decode — works for paths without hyphens
const simpleEncoded = entries.find(e => e.includes('Playground'));
if (simpleEncoded) {
  const decoded = decodeProjectPath(simpleEncoded);
  assert(existsSync(decoded), `Simple path decodes correctly: ${decoded}`);
}

// Test ambiguous decode — projects with hyphens in name (claude-tower, storage-analyzer)
const claudeTowerEncoded = entries.find(e => e.includes('claude-tower'));
if (claudeTowerEncoded) {
  const naiveDecoded = decodeProjectPath(claudeTowerEncoded);
  assert(!existsSync(naiveDecoded), `Naive decode fails for hyphenated names: ${naiveDecoded} (expected)`);

  // Verify the cwd-from-JSONL fallback works
  const projectDir = join(PROJECTS_DIR, claudeTowerEncoded);
  const jsonls = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
  if (jsonls.length > 0) {
    const raw = readFileSync(join(projectDir, jsonls[0]), 'utf-8');
    const firstEvents = raw.split('\n').slice(0, 10).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const cwdEvent = firstEvents.find(e => e.cwd);
    if (cwdEvent) {
      assert(existsSync(cwdEvent.cwd), `JSONL cwd fallback resolves correctly: ${cwdEvent.cwd}`);
      assert(cwdEvent.cwd.includes('claude-tower'), `Resolved path contains claude-tower`);
    }
  }
}

// ─── Test 2: Session discovery (files directly in project dir, NOT sessions/) ───

console.log('\n── Session discovery ──');

const projectDir = getSessionsDir(claudeTowerEncoded || simpleEncoded || entries[0]);
const allFiles = readdirSync(projectDir);
const jsonlFiles = allFiles.filter(f => f.endsWith('.jsonl'));

assert(jsonlFiles.length > 0, `Found ${jsonlFiles.length} JSONL files in ${basename(projectDir)}`);
assert(!allFiles.includes('sessions'), `No sessions/ subdirectory (files are in project root)`);

// ─── Test 3: JSONL parsing — real event types ───

console.log('\n── JSONL event types ──');

const testFile = join(projectDir, jsonlFiles[0]);
const raw = readFileSync(testFile, 'utf-8');
const lines = raw.split('\n').filter(l => l.trim());
const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

assert(events.length > 0, `Parsed ${events.length} events from ${basename(testFile)}`);

const types = new Set(events.map(e => e.type));
console.log(`  Event types found: ${[...types].join(', ')}`);

assert(!types.has('message'), `No type:"message" events (correct — real format uses type:"user"/"assistant")`);
assert(!types.has('session_start'), `No type:"session_start" events (correct — doesn't exist)`);
assert(!types.has('session_end'), `No type:"session_end" events (correct — doesn't exist)`);
assert(types.has('user') || types.has('assistant'), `Has type:"user" and/or type:"assistant" events`);

// ─── Test 4: Assistant event structure ───

console.log('\n── Assistant event structure ──');

const assistantEvent = events.find(e => e.type === 'assistant');
if (assistantEvent) {
  assert(assistantEvent.message !== undefined, `Assistant event has .message`);
  assert(assistantEvent.message.role === 'assistant', `Assistant event .message.role === "assistant"`);
  assert(Array.isArray(assistantEvent.message.content), `Assistant event .message.content is array`);
  assert(assistantEvent.sessionId !== undefined, `Assistant event has .sessionId`);

  const block = assistantEvent.message.content[0];
  assert(
    block.type === 'text' || block.type === 'tool_use' || block.type === 'thinking',
    `Content block type is text/tool_use/thinking (got: ${block.type})`
  );

  // Check streaming: multiple assistant events with same message.id
  const msgId = assistantEvent.message.id;
  const sameId = events.filter(e => e.type === 'assistant' && e.message?.id === msgId);
  if (sameId.length > 1) {
    assert(true, `Streaming confirmed: ${sameId.length} chunks share message.id ${msgId.slice(0, 20)}...`);
    const stopReasons = sameId.map(e => e.message.stop_reason).filter(Boolean);
    assert(stopReasons.length <= 1, `At most 1 chunk has stop_reason set (got ${stopReasons.length})`);
  }
} else {
  console.log('  (no assistant events in this file)');
}

// ─── Test 5: User event structure (tool_result) ───

console.log('\n── User event structure ──');

const toolResultEvent = events.find(e =>
  e.type === 'user' &&
  Array.isArray(e.message?.content) &&
  e.message.content.some(b => b.type === 'tool_result')
);
if (toolResultEvent) {
  const block = toolResultEvent.message.content.find(b => b.type === 'tool_result');
  assert(block.tool_use_id !== undefined, `tool_result has .tool_use_id: ${block.tool_use_id.slice(0, 20)}...`);
  assert(block.content !== undefined || block.is_error !== undefined, `tool_result has .content or .is_error`);
} else {
  console.log('  (no tool_result events in this file)');
}

// ─── Test 6: Tool use → tool result matching ───

console.log('\n── Tool use/result matching ──');

const toolUseIds = new Set();
const toolResultIdSet = new Set();

for (const e of events) {
  const content = e.message?.content;
  if (!Array.isArray(content)) continue;
  for (const block of content) {
    if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id);
    if (block.type === 'tool_result' && block.tool_use_id) toolResultIdSet.add(block.tool_use_id);
  }
}

const unresolved = [...toolUseIds].filter(id => !toolResultIdSet.has(id));
console.log(`  Tool uses: ${toolUseIds.size}, Tool results: ${toolResultIdSet.size}, Unresolved: ${unresolved.length}`);

// For a completed session, all should be resolved (or at most the last one pending)
assert(unresolved.length <= 1, `At most 1 unresolved tool_use (session may be active)`);

// ─── Test 7: Session status detection heuristics ───

console.log('\n── Session status signals ──');

const lastEvent = events[events.length - 1];
console.log(`  Last event type: ${lastEvent.type}`);

if (lastEvent.type === 'last-prompt' || lastEvent.type === 'pr-link') {
  assert(true, `Strong completion signal: ${lastEvent.type}`);
}

// Find last assistant stop_reason
for (let i = events.length - 1; i >= 0; i--) {
  if (events[i].type === 'assistant' && events[i].message?.stop_reason) {
    console.log(`  Last stop_reason: ${events[i].message.stop_reason}`);
    break;
  }
}

// Check ai-title
const aiTitle = events.find(e => e.type === 'ai-title');
if (aiTitle) {
  assert(aiTitle.aiTitle !== undefined, `ai-title has .aiTitle: "${aiTitle.aiTitle}"`);
}

// ─── Test 8: Tail reader simulation (8KB) ───

console.log('\n── Tail reader (8KB) ──');

const stat = statSync(testFile);
const tailSize = Math.min(8192, stat.size);
const buf = Buffer.alloc(tailSize);
const fd = openSync(testFile, 'r');
readSync(fd, buf, 0, tailSize, stat.size - tailSize);
closeSync(fd);

let tailText = buf.toString('utf-8');
// Skip first partial line if offset > 0
if (stat.size > tailSize) {
  const nl = tailText.indexOf('\n');
  if (nl !== -1) tailText = tailText.slice(nl + 1);
}
const tailLines = tailText.split('\n').filter(l => l.trim());
const tailEvents = tailLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

assert(tailEvents.length > 0, `Tail reader got ${tailEvents.length} events from last 8KB`);
assert(tailEvents.every(e => e.type), `All tail events have a type field`);

// ─── Test 9: Cross-project session counts ───

console.log('\n── Cross-project scan ──');

let totalSessions = 0;
let projectsWithSessions = 0;
for (const dir of entries.slice(0, 10)) {
  const pDir = join(PROJECTS_DIR, dir);
  try {
    const pStat = statSync(pDir);
    if (!pStat.isDirectory()) continue;
    const pFiles = readdirSync(pDir).filter(f => f.endsWith('.jsonl'));
    if (pFiles.length > 0) {
      totalSessions += pFiles.length;
      projectsWithSessions++;
    }
  } catch {}
}
assert(projectsWithSessions > 0, `${projectsWithSessions} projects have sessions (${totalSessions} total JSONL files)`);

// ─── Test 10: sessions-index.json ───

console.log('\n── sessions-index.json ──');

const indexPath = join(PROJECTS_DIR, '-', 'sessions-index.json');
if (existsSync(indexPath)) {
  const idx = JSON.parse(readFileSync(indexPath, 'utf-8'));
  assert(idx.version === 1, `sessions-index.json version is 1`);
  assert(Array.isArray(idx.entries), `sessions-index.json has entries array`);
  if (idx.entries.length > 0) {
    const e = idx.entries[0];
    assert(e.sessionId !== undefined, `Entry has sessionId`);
    assert(e.fullPath !== undefined, `Entry has fullPath`);
    console.log(`  ${idx.entries.length} entries in index`);
  }
} else {
  console.log('  sessions-index.json not found (only exists at root project)');
}

// ─── Summary ───

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
