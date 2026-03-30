# Claude Tower — VS Code Extension

## Build & Test
- `npm run build` — esbuild bundle to `dist/extension.js`
- `npm test` — unit tests (Node.js built-in test runner + tsx)
- `F5` in VS Code — launches Extension Development Host for manual testing
- `npx vsce package` — creates `.vsix` for local install

## CI/CD
- **CI**: runs tests + build on every PR (`.github/workflows/ci.yml`)
- **Publish**: on merge to main, auto-tags + publishes if version changed (`.github/workflows/publish.yml`)
- **Branch protection**: main requires PRs + passing `test` status check (GitHub ruleset)
- To release a new version:
  1. Bump `version` in `package.json`
  2. Update `CHANGELOG.md`
  3. Open PR → CI passes → merge
  4. Publish workflow auto-tags `v{version}`, publishes to marketplace, creates GitHub release

## Architecture
- Single-view extension: Sessions panel in the secondary sidebar
- Status detection: hooks (primary) > process alive (secondary) > JSONL heuristics (fallback)
- Hooks are installed in `~/.claude/settings.json` on first activation (see `HooksManager.ts`)
- Session registration files at `~/.claude/sessions/<PID>.json` provide exact PID-to-session mapping
- Process alive checked via `ps -p <pids>` (CPU readings are bursty and not used for status decisions)
- JSONL tails are 8KB — never read full session files

## Key files
- `src/views/SessionListProvider.ts` — the main tree view (groups, ticking, grace periods)
- `src/views/items.ts` — tree item classes (StatusGroupItem, SessionListItem, ReadyItem, LoadMoreItem)
- `src/state/SessionScanner.ts` — `detectSessionStatus()` is the core status detection logic
- `src/state/ProcessMonitor.ts` — reads `~/.claude/sessions/` + CPU monitoring
- `src/state/HooksManager.ts` — installs/reads Claude Code lifecycle hooks
- `src/state/TowerStateManager.ts` — orchestrates scanning, caching, state changes

## Code style
- TypeScript with ES modules, bundled by esbuild
- Tests in `test/unit/` — run with `npm test`
- Avoid `ps aux | grep` patterns — use `~/.claude/sessions/` registration files instead
- Path encoding: `encodeProjectPath()` replaces both `/` and `.` with `-` (matches Claude Code's encoding)

## Common gotchas
- Hook commands receive data via **stdin JSON**, not environment variables (`$CLAUDE_SESSION_ID` does NOT exist)
- `Stop` hook fires between every tool call, not just at session end — use 5s grace before treating as "done"
- CPU is bursty — status detection relies on hooks + process alive, not CPU readings
- VS Code `QuickPick` buttons only show icons, no text labels
- `_onDidChangeTreeData.fire()` without args causes a loading indicator flicker — fire per-item instead
- Cached state strips `lastAssistantMessage` but keeps session metadata for instant startup
