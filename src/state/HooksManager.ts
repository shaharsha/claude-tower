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
  const writeCmd = (status: HookSessionStatus) =>
    `SID=$(cat | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4); [ -n "$SID" ] && echo '{"status":"${status}","ts":'$(date +%s000)'}' > "${STATUS_DIR}/$SID.json"`;

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
 */
export function readHookStatus(sessionId: string): { status: HookSessionStatus; ts: number } | undefined {
  const filePath = path.join(STATUS_DIR, `${sessionId}.json`);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.status && data.ts) {
      return data;
    }
  } catch {
    // File doesn't exist or is malformed
  }
  return undefined;
}

/**
 * Check if hooks are already installed (with the stdin-based version).
 */
export function areHooksInstalled(): boolean {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks?.Notification;
    // Check that Notification hook uses empty matcher (catches all notifications)
    // Old versions used 'permission_prompt' matcher which misses plan approval
    return Array.isArray(hooks) && hooks.some(
      (h: any) => h.matcher === '' &&
        h.hooks?.some?.((hh: any) => hh.command?.includes?.('.claude-tower/')),
    );
  } catch {
    return false;
  }
}
