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
- WebviewView sidebar: sessions rendered as HTML cards (not TreeView)
- Status detection: hooks (primary) > process alive (secondary) > JSONL heuristics (fallback)
- Hooks installed in `~/.claude/settings.json` on first activation — atomic writes (`.tmp` + `mv`)
- Hook read cache prevents race conditions during file rewrites
- Session registration files at `~/.claude/sessions/<PID>.json` provide exact PID-to-session mapping
- Process alive checked via `ps -p <pids>` (CPU readings are bursty and not used for status decisions)
- JSONL tails are 8KB — never read full session files

## Key files
- `src/views/SessionWebviewProvider.ts` — WebviewView provider (state → groups → messages to webview)
- `src/views/sessionWebviewHtml.ts` — HTML/CSS/JS template for the sidebar webview
- `src/views/sessionWebviewMessages.ts` — TypeScript types for extension ↔ webview message protocol
- `src/state/SessionScanner.ts` — `detectSessionStatus()` is the core status detection logic
- `src/state/ProcessMonitor.ts` — reads `~/.claude/sessions/` + process alive checks
- `src/state/HooksManager.ts` — installs/reads Claude Code lifecycle hooks (atomic writes + read cache)
- `src/state/TowerStateManager.ts` — orchestrates scanning, caching, state changes
- `src/util/formatTime.ts` — elapsed time formatting helpers

## Code style
- TypeScript with ES modules, bundled by esbuild
- Tests in `test/unit/` — run with `npm test`
- Avoid `ps aux | grep` patterns — use `~/.claude/sessions/` registration files instead
- Path encoding: `encodeProjectPath()` replaces both `/` and `.` with `-` (matches Claude Code's encoding)

## Common gotchas
- Hook commands receive data via **stdin JSON**, not environment variables (`$CLAUDE_SESSION_ID` does NOT exist)
- `Stop` hook fires between every tool call, not just at session end — check `isLastResponseComplete` to distinguish
- Hook file writes must be atomic (`.tmp` + `mv`) — non-atomic `echo >` creates a race where the file is briefly empty
- CPU is brusty — status detection relies on hooks + process alive, not CPU readings
- Webview actions (open, ship, remove) use `postMessage` → extension commands (no TreeView item context menus)
- Cached state strips `lastAssistantMessage` but keeps session metadata for instant startup
