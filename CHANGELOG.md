# Changelog

## 0.1.0

Initial release.

- Board view with Backlog / In Progress / Review / Done columns
- Auto-discovery of Claude Code sessions from `~/.claude/projects/`
- Live session status detection (working, waiting, done, error, idle)
- Approval preview — see what Claude is asking without switching windows
- Diff stats on completed tasks
- One-click navigation to any session
- Task creation — worktree or same-workspace mode
- Ship flow — Claude-assisted or quick commit + push + PR
- Archive with worktree cleanup
- Status bar with ambient session counts
- Activity bar badge for attention-needing items
- Toast notifications with 5-second batching
- "While you were away" activity summary
- Custom prompt templates (`.claude-tower/prompt-template.md`)
- Lifecycle hooks — postCreate and preArchive scripts
- Settings webview for all configuration
- Optional Linear integration
  - OAuth via Linear Connect extension
  - Backlog from Linear tickets
  - One-click start with ticket context and images
  - Two-way status sync
