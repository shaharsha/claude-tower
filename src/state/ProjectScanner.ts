import * as fs from 'fs';
import * as path from 'path';

import type { TowerProject, TowerWorktree } from '../types';
import {
  getClaudeProjectsDir,
  decodeProjectPath,
  getSessionsDir,
} from '../util/claudePaths';
import { readJsonlHead } from '../util/jsonlReader';
import { exec } from '../util/exec';
import { WorktreeScanner } from './WorktreeScanner';

export class ProjectScanner {
  private worktreeScanner = new WorktreeScanner();

  /**
   * Scan ~/.claude/projects/ to discover projects.
   *
   * For each encoded directory:
   *   1. Decode path and check if it exists on disk.
   *   2. Check if any session file was modified within `recentDays`.
   *   3. Populate worktrees via git.
   *
   * Returns projects sorted by most recent session activity (descending).
   */
  async scanProjects(recentDays: number): Promise<TowerProject[]> {
    const projectsDir = getClaudeProjectsDir();

    let entries: string[];
    try {
      entries = await fs.promises.readdir(projectsDir);
    } catch {
      return [];
    }

    const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
    const projects: TowerProject[] = [];
    const seenGitRoots = new Set<string>();

    for (const encodedDir of entries) {
      const fullDirPath = path.join(projectsDir, encodedDir);

      // Skip non-directories
      let dirStat: fs.Stats;
      try {
        dirStat = await fs.promises.stat(fullDirPath);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) {
        continue;
      }

      // Check for recent session activity
      const projectMetaDir = getSessionsDir(encodedDir);
      const { hasRecentSession, latestMtime } = await this.checkRecentSessions(
        projectMetaDir,
        cutoff,
      );

      // Resolve the real project path. Naive decode is ambiguous for paths
      // with hyphens (e.g., "claude-tower" → "claude/tower"). If it fails,
      // extract the real cwd from the first JSONL event.
      let resolvedPath = decodeProjectPath(encodedDir);
      let exists = fs.existsSync(resolvedPath);

      if (!exists) {
        // Fallback: read cwd from a JSONL session file
        const cwdFromJsonl = await this.extractCwdFromJsonl(projectMetaDir);
        if (cwdFromJsonl) {
          resolvedPath = cwdFromJsonl;
          exists = fs.existsSync(resolvedPath);
        }
      }

      // Only keep projects that exist on disk
      if (!exists) {
        continue;
      }

      // Deduplicate projects that share a git repo. Conductor workspaces
      // are worktrees of a main repo — use --git-common-dir to find it.
      let gitCommonDir: string | undefined;
      if (exists) {
        try {
          const raw = (await exec(
            `git -C '${resolvedPath.replace(/'/g, "'\\''")}' rev-parse --path-format=absolute --git-common-dir`,
            { timeout: 5000 },
          )).trim();
          // raw is like /path/to/repo/.git — parent is the repo root
          if (raw.endsWith('/.git')) {
            gitCommonDir = raw.slice(0, -5);
          } else {
            gitCommonDir = path.dirname(raw);
          }
        } catch {
          // Not a git repo
        }
      }

      // If this is a worktree of an already-seen repo, skip it
      if (gitCommonDir && seenGitRoots.has(gitCommonDir)) {
        continue;
      }
      if (gitCommonDir) {
        seenGitRoots.add(gitCommonDir);
      }

      // Also deduplicate by resolved path — multiple encoded dirs
      // may resolve to the same cwd (e.g., deleted conductor worktrees
      // that still have JSONL entries)
      const repoRoot = gitCommonDir ?? resolvedPath;
      if (seenGitRoots.has(repoRoot) && !gitCommonDir) {
        continue;
      }
      seenGitRoots.add(repoRoot);

      // Skip non-project paths (home dir, root, etc.)
      if (resolvedPath === require('os').homedir() || resolvedPath === '/') {
        continue;
      }

      // Populate worktrees from the main repo root (not the worktree itself)
      let worktrees: TowerWorktree[] = [];
      if (exists) {
        try {
          worktrees = await this.worktreeScanner.getWorktrees(repoRoot);
        } catch {
          // Not a git repo or git not available — that's fine
        }
      }

      const projectName = path.basename(repoRoot);

      projects.push({
        id: encodedDir,
        path: repoRoot,
        name: projectName,
        exists,
        worktrees,
        _latestMtime: latestMtime,
      } as TowerProject & { _latestMtime: number });
    }

    // Sort by most recent session activity (reuse cached mtime, no second scan)
    projects.sort((a, b) => {
      const aMtime = (a as any)._latestMtime ?? 0;
      const bMtime = (b as any)._latestMtime ?? 0;
      return bMtime - aMtime;
    });

    // Remove orphaned non-git dirs that are siblings of known worktrees.
    // Map each parent dir to the set of project roots that have worktrees there.
    const parentToProjectRoots = new Map<string, Set<string>>();
    for (const p of projects) {
      for (const wt of p.worktrees) {
        const parentDir = path.dirname(wt.path);
        if (!parentToProjectRoots.has(parentDir)) {
          parentToProjectRoots.set(parentDir, new Set());
        }
        parentToProjectRoots.get(parentDir)!.add(p.path);
      }
    }

    const filtered = projects.filter((p) => {
      // Keep all git-backed projects
      if (p.worktrees.length > 0) { return true; }
      // Non-git project: only filter as orphan if its parent dir contains
      // worktrees from exactly ONE project (conductor-style orphan).
      // If multiple projects share the parent dir, it's a normal projects folder.
      const parentDir = path.dirname(p.path);
      const projectRoots = parentToProjectRoots.get(parentDir);
      if (projectRoots && projectRoots.size === 1) { return false; }
      // Also skip if nested inside another project
      const pPath = p.path + '/';
      if (projects.some((o) => o !== p && pPath.startsWith(o.path + '/'))) { return false; }
      return true;
    });

    // Clean up the temporary property
    for (const p of filtered) {
      delete (p as any)._latestMtime;
    }

    return filtered;
  }

  /**
   * Extract the real project cwd from the first JSONL session file.
   * Claude Code events contain a `cwd` field with the actual project path.
   * This resolves the path-encoding ambiguity (hyphens in dir names).
   */
  private async extractCwdFromJsonl(projectDir: string): Promise<string | null> {
    try {
      const files = await fs.promises.readdir(projectDir);
      const jsonlFile = files.find((f) => f.endsWith('.jsonl'));
      if (!jsonlFile) { return null; }

      const filePath = path.join(projectDir, jsonlFile);
      const events = await readJsonlHead(filePath, 2048);

      for (const event of events) {
        const cwd = (event as any).cwd;
        if (cwd && typeof cwd === 'string') {
          return cwd;
        }
      }
    } catch {
      // File may not be readable
    }
    return null;
  }

  /**
   * Check if any session JSONL file was modified within the cutoff time.
   * Returns whether a recent session exists and the latest mtime found.
   */
  private async checkRecentSessions(
    sessionsDir: string,
    cutoff: number,
  ): Promise<{ hasRecentSession: boolean; latestMtime: number }> {
    let hasRecentSession = false;
    let latestMtime = 0;

    try {
      const sessionFiles = await fs.promises.readdir(sessionsDir);
      for (const file of sessionFiles) {
        if (!file.endsWith('.jsonl')) {
          continue;
        }
        try {
          const stat = await fs.promises.stat(path.join(sessionsDir, file));
          const mtime = stat.mtimeMs;
          if (mtime > latestMtime) {
            latestMtime = mtime;
          }
          if (mtime >= cutoff) {
            hasRecentSession = true;
          }
        } catch {
          // File may have been deleted between readdir and stat
        }
      }
    } catch {
      // Sessions directory may not exist
    }

    return { hasRecentSession, latestMtime };
  }
}
