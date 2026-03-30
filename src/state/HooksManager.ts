import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type HookSessionStatus = 'working' | 'waiting' | 'idle';

const STATUS_DIR = path.join(os.homedir(), '.claude-tower', 'session-status');

/**
 * Install Claude Code hooks in ~/.claude/settings.json to track session status.
 * Hooks receive event data via stdin JSON (including session_id).
 * They write status files to ~/.claude-tower/session-status/<session-id>.json.
 */
export function installHooks(): void {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // No settings file yet
  }

  // Ensure status directory exists
  fs.mkdirSync(STATUS_DIR, { recursive: true });

  // Hook commands read session_id from stdin JSON (piped by Claude Code)
  // Atomic write: write to .tmp then mv (mv is atomic on same filesystem).
  // Prevents race where the scanner reads a truncated/empty file mid-write.
  const writeCmd = (status: HookSessionStatus) =>
    `SID=$(cat | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4); [ -n "$SID" ] && echo '{"status":"${status}","ts":'$(date +%s000)'}' > "${STATUS_DIR}/$SID.json.tmp" && mv "${STATUS_DIR}/$SID.json.tmp" "${STATUS_DIR}/$SID.json"`;

  const rmCmd =
    `SID=$(cat | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4); [ -n "$SID" ] && rm -f "${STATUS_DIR}/$SID.json"`;

  const towerHooks: Record<string, any[]> = {
    UserPromptSubmit: [
      { matcher: '', hooks: [{ type: 'command', command: writeCmd('working'), timeout: 2000 }] },
    ],
    PreToolUse: [
      { matcher: '', hooks: [{ type: 'command', command: writeCmd('working'), timeout: 2000 }] },
    ],
    SubagentStart: [
      { matcher: '', hooks: [{ type: 'command', command: writeCmd('working'), timeout: 2000 }] },
    ],
    Stop: [
      { matcher: '', hooks: [{ type: 'command', command: writeCmd('idle'), timeout: 2000 }] },
    ],
    Notification: [
      { matcher: '', hooks: [{ type: 'command', command: writeCmd('waiting'), timeout: 2000 }] },
    ],
    SessionEnd: [
      { matcher: '', hooks: [{ type: 'command', command: rmCmd, timeout: 2000 }] },
    ],
  };

  // Merge with existing hooks (don't overwrite user hooks)
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [event, hookDefs] of Object.entries(towerHooks)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Remove any existing claude-tower hooks (idempotent reinstall)
    settings.hooks[event] = settings.hooks[event].filter(
      (h: any) => !h.hooks?.some?.((hh: any) => hh.command?.includes?.('.claude-tower/')),
    );

    // Add our hooks
    settings.hooks[event].push(...hookDefs);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Read the hook-written status for a session.
 * Caches last good read to handle the race condition where the file is
 * briefly empty/truncated while a hook command rewrites it (non-atomic echo >).
 */
const hookReadCache = new Map<string, { status: HookSessionStatus; ts: number }>();

export function readHookStatus(sessionId: string): { status: HookSessionStatus; ts: number } | undefined {
  const filePath = path.join(STATUS_DIR, `${sessionId}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.status && data.ts) {
      hookReadCache.set(sessionId, data);
      return data;
    }
  } catch (err: any) {
    // ENOENT = file deleted (SessionEnd) or never created → clear cache
    if (err?.code === 'ENOENT') {
      hookReadCache.delete(sessionId);
      return undefined;
    }
    // Other error (empty file, invalid JSON) = transient race condition
    // Return last known good value
    return hookReadCache.get(sessionId);
  }
  return undefined;
}

/**
 * Check if hooks are already installed (with the latest atomic-write version).
 */
export function areHooksInstalled(): boolean {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks?.Notification;
    // Check that Notification hook uses empty matcher AND atomic writes (mv).
    // Old versions used non-atomic `echo > file` which causes race conditions.
    return Array.isArray(hooks) && hooks.some(
      (h: any) => h.matcher === '' &&
        h.hooks?.some?.((hh: any) => hh.command?.includes?.('.json.tmp') && hh.command?.includes?.('.claude-tower/')),
    );
  } catch {
    return false;
  }
}
