import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from '../util/exec';

/** Session registration from ~/.claude/sessions/<PID>.json */
interface SessionRegistration {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  entrypoint: string;
}

export interface AliveProcessInfo {
  /** All alive session registrations, keyed by session ID */
  sessions: Map<string, SessionRegistration>;
  /** CWDs of all alive sessions */
  cwds: Set<string>;
  /** Session IDs of all alive sessions */
  sessionIds: Set<string>;
  /** CWDs where at least one session was recently active (CPU > threshold) */
  activeCwds: Set<string>;
  /** Session IDs where the process is actively using CPU */
  activeSessionIds: Set<string>;
}

const CPU_ACTIVE_THRESHOLD = 0.5;

export class ProcessMonitor {
  private cached: AliveProcessInfo | undefined;
  private cacheTimestamp = 0;
  private static readonly CACHE_TTL_MS = 3000;

  async getAliveProcessInfo(): Promise<AliveProcessInfo> {
    const now = Date.now();

    if (this.cached && now - this.cacheTimestamp < ProcessMonitor.CACHE_TTL_MS) {
      return this.cached;
    }

    const sessions = new Map<string, SessionRegistration>();
    const cwds = new Set<string>();
    const sessionIds = new Set<string>();
    const activeCwds = new Set<string>();
    const activeSessionIds = new Set<string>();

    // Read session registrations from ~/.claude/sessions/
    const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
    const registrations = await this.readSessionRegistrations(sessionsDir);

    // Get CPU usage for all PIDs in one call
    const pids = registrations.map((r) => r.pid);
    const cpuByPid = await this.getCpuForPids(pids);

    for (const reg of registrations) {
      // Verify process is still alive
      const cpu = cpuByPid.get(reg.pid);
      if (cpu === undefined) {
        continue; // Process dead, skip
      }

      sessions.set(reg.sessionId, reg);
      cwds.add(reg.cwd);
      sessionIds.add(reg.sessionId);

      // Active if current CPU reading exceeds threshold (no history — hooks handle smoothing)
      if (cpu > CPU_ACTIVE_THRESHOLD) {
        activeSessionIds.add(reg.sessionId);
        activeCwds.add(reg.cwd);
      }
    }

    this.cached = { sessions, cwds, sessionIds, activeCwds, activeSessionIds };
    this.cacheTimestamp = now;
    return this.cached;
  }

  async getClaudeProcessCwds(): Promise<Set<string>> {
    const info = await this.getAliveProcessInfo();
    return info.cwds;
  }

  /**
   * Read all session registration files from ~/.claude/sessions/.
   * Each file is <PID>.json with {pid, sessionId, cwd, startedAt, kind, entrypoint}.
   */
  private async readSessionRegistrations(dir: string): Promise<SessionRegistration[]> {
    const registrations: SessionRegistration[] = [];

    let files: string[];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      return [];
    }

    for (const file of files) {
      if (!file.endsWith('.json')) { continue; }
      try {
        const raw = await fs.promises.readFile(path.join(dir, file), 'utf-8');
        const reg = JSON.parse(raw) as SessionRegistration;
        if (reg.pid && reg.sessionId && reg.cwd) {
          registrations.push(reg);
        }
      } catch {
        // Malformed or unreadable
      }
    }

    return registrations;
  }

  /**
   * Get CPU usage for multiple PIDs in a single ps call.
   * Returns Map<pid, cpuPercent>. Missing PIDs = process dead.
   */
  private async getCpuForPids(pids: number[]): Promise<Map<number, number>> {
    const cpuMap = new Map<number, number>();
    if (pids.length === 0) { return cpuMap; }

    try {
      const pidList = pids.join(',');
      const output = await exec(
        `ps -p ${pidList} -o pid=,pcpu= 2>/dev/null`,
        { timeout: 5000 },
      );

      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[0], 10);
          const cpu = parseFloat(parts[1]) || 0;
          if (!isNaN(pid)) {
            cpuMap.set(pid, cpu);
          }
        }
      }
    } catch {
      // ps failed
    }

    return cpuMap;
  }

  invalidateCache(): void {
    this.cached = undefined;
    this.cacheTimestamp = 0;
  }
}
