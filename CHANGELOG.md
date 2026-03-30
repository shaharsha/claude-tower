# Changelog

## 0.2.11

- **WebviewView sidebar** — card-based session list with colored accents, two-line layout, hover-reveal actions, collapsible groups, right-click context menu, double-click to open
- **Fix hook file race condition** — atomic writes (`.tmp` + `mv`) + read cache. Root cause of Running ↔ Recent oscillation.
- **Fix completed sessions stuck in Running** — idle hook now checks JSONL completion before alive grace period
- **Strip "You are working on:" prefix** from Linear-started session titles
- **Auto-reinstall hooks** when old non-atomic version detected
- **175 tests** — real Claude Code behavior simulations (rapid tool loops, thinking gaps, crashes, race conditions)

## 0.2.10

- **Fix status oscillation** — trust fresh hooks unconditionally instead of overriding with JSONL heuristics. Fixes active sessions jumping between Running/Needs Attention/Recent.
- **Remove CPU reliance** — status detection now uses hooks + process alive + JSONL only. CPU readings were bursty and caused false signals.
- **Extended trust for long tools** — stale working hooks trusted up to 10 min when process is alive (covers long subagent tasks).
- **Unit tests** — 122 tests covering all status detection paths, including timeline-based scenarios for tool loops, permission prompts, subagents, interrupts, errors, and multi-turn conversations.
- **CI/CD** — GitHub Actions: tests on PRs, auto-publish to marketplace on merge when version changes. Branch protection via ruleset.

## 0.2.9

- **Ship button pastes prompt into existing session** — copies ship prompt to clipboard, focuses the session, and simulates ⌘V to paste into Claude Code's input field. Falls back to a toast if paste fails.

## 0.2.8

- **Fix interrupted sessions stuck in Running** — stale "working" hooks (>5 min, no CPU) now fall through to JSONL heuristics instead of being trusted forever
- **Fix idle detection** — uses `end_turn` from JSONL to distinguish "between tool calls" from "turn completed"; 2-min grace for server-side thinking periods

## 0.2.7

- **Ship button sends prompt to existing session** — resumes the session with `?session=<id>&prompt=...` instead of creating a new empty session
- **Fix duplicate Claude Code tabs** — routes `vscode://` URIs through macOS `open` command to target the focused window, not the extension host window

## 0.2.6

- **Git fetch before worktree** — new worktrees branch from `origin/main` (latest remote), not stale local main
- Fetches automatically before creating worktrees (both manual and Linear flows)

## 0.2.5

- Update changelog in published package

## 0.2.4

- **Ship button** (rocket icon) on completed sessions — opens worktree and sends Claude Code a PR creation prompt
- Configurable ship prompt: per-project (`.claude-tower/config.json` → `ship.prompt`) or global (VS Code setting `claude-tower.shipPrompt`)
- Ship hidden on Running/Needs Attention sessions

## 0.2.3

- Fix plan approval detection — broader notification hooks (catches all notification types, not just `permission_prompt`)
- Scanner override: detect "waiting" when hook says "working" but CPU is low + unresolved tool_use + no recent writes
- Auto-reinstall hooks when old matcher-based version detected

## 0.2.2

- Auto-open Claude Tower sidebar on VS Code startup (`onStartupFinished` activation)
- Trust "working" hooks for 5 minutes (was 30s — Claude thinks for 60s+ between tool calls)
- Multiple focus retries (0ms, 500ms, 1.5s, 3s) for reliable sidebar open on new windows

## 0.2.1

- Fix marketplace changelog (included in published package)

## 0.2.0

Major architecture overhaul — single Sessions view with reliable status detection.

### Session Monitoring
- **Hook-based status detection** — installs Claude Code lifecycle hooks for definitive working/idle/waiting signals
- **CPU monitoring** — reads `~/.claude/sessions/<PID>.json` registration files, single `ps -p` call for CPU
- **JSONL heuristics** — fallback for sessions without hooks
- **Auto-read detection** — sessions auto-mark as read when opened in any VS Code window
- **Progressive loading** — sessions appear instantly from cache, fresh data loads in background
- **Live elapsed timers** — per-item refresh (no loading indicator flicker)

### Session Groups
- **Running** — live elapsed counter, green play icon
- **Needs Attention** — waiting for approval or errors, yellow bell-dot icon
- **To Review** — completed but unread, blue eye icon
- **Recent** — reviewed within last 2 hours, clock icon
- **Done** — older completed sessions, dimmed check icon
- **New Worktrees** — worktrees created but not yet started, purple git-branch icon

### Actions
- **[+] button** — New Chat, New Worktree, Start from Linear
- **Project picker** — choose which repo to start in (for multi-project setups)
- **Open Chat** — inline button to focus window + open specific session
- **Remove Worktree** — right-click context menu with confirmation
- **Load More** — paginated Done group (20 at a time)

### Linear Integration
- **Single GraphQL query** — fetches all tickets in one call (sub-second)
- **Inline filters** — team, status, assignee dropdowns with persistent selections
- **Free text search** — filter by title, ID, or description
- **Smart prompts** — ticket context with images, no redundant instructions
- **Branch conflict handling** — reuse existing or create suffixed branch
- **Proper attachment filenames** — extracted from markdown alt text, deduplicated

### UX
- Timing format: precise for Running (2m 30s), compact for others (2m, 1h)
- Color-coded bullets: green (running), yellow (waiting), red (error), blue (to review), dimmed (done)
- Loading state on startup (no empty state flash)
- Cached sessions for instant startup on subsequent opens

## 0.1.0

Initial release.

- Board view with task columns
- Auto-discovery of Claude Code sessions
- Linear integration with OAuth
- Worktree management
- Status bar and notifications
