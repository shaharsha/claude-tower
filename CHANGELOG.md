# Changelog

## 0.2.4

- **Ship button** (rocket icon) on completed sessions — opens worktree and sends Claude Code a PR creation prompt
- Configurable ship prompt: per-project (`.claude-tower/config.json` → `ship.prompt`) or global (VS Code setting `claude-tower.shipPrompt`)
- Ship hidden on Running/Needs Attention sessions
- Fix plan approval detection — broader notification hooks (catches all notification types)
- Trust "working" hooks for 5 minutes (Claude can think for 60+ seconds between tool calls)
- Auto-open Claude Tower sidebar on VS Code startup (`onStartupFinished`)
- Multiple focus retries for reliable sidebar open on new windows
- Project picker when starting from Linear (choose which repo)
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
