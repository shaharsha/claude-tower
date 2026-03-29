# Claude Tower — VS Code Extension

## Build & Test
- `npm run build` — esbuild bundle to `dist/extension.js`
- `F5` in VS Code — launches Extension Development Host for testing
- `npx vsce package` — creates `.vsix` for local install
- `npx vsce publish --pat <PAT>` — publish to VS Code Marketplace (publisher: `shaharsha`)
- Bump `version` in `package.json` before each publish (marketplace rejects duplicate versions)

## Architecture
- Single-view extension: Sessions panel in the secondary sidebar
- Status detection: hooks (primary) > CPU (secondary) > JSONL heuristics (fallback)
- Hooks are installed in `~/.claude/settings.json` on first activation (see `HooksManager.ts`)
- Session registration files at `~/.claude/sessions/<PID>.json` provide exact PID-to-session mapping
- Process CPU checked via single `ps -p <pids> -o pid=,pcpu=` call (no `ps aux` grep)
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
- No tests yet — use `F5` debug host for manual testing
- Avoid `ps aux | grep` patterns — use `~/.claude/sessions/` registration files instead
- Path encoding: `encodeProjectPath()` replaces both `/` and `.` with `-` (matches Claude Code's encoding)

## Common gotchas
- Hook commands receive data via **stdin JSON**, not environment variables (`$CLAUDE_SESSION_ID` does NOT exist)
- `Stop` hook fires between every tool call, not just at session end — use 5s grace before treating as "done"
- CPU is bursty (5% → 0.3% → 6% between samples) — don't rely on single readings
- VS Code `QuickPick` buttons only show icons, no text labels
- `_onDidChangeTreeData.fire()` without args causes a loading indicator flicker — fire per-item instead
- Cached state strips `lastAssistantMessage` but keeps session metadata for instant startup
