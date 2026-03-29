<h1 align="center">Claude Tower</h1>

<p align="center">
  <strong>A control tower for your Claude Code agents.</strong>
</p>

<p align="center">
  Monitor and manage all your parallel Claude Code sessions from a single VS Code sidebar. See what's running, what needs attention, and what's done — across all projects and worktrees.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=shaharsha.claude-tower">
    <img src="https://img.shields.io/visual-studio-marketplace/v/shaharsha.claude-tower?label=VS%20Code%20Marketplace&color=blue" alt="VS Code Marketplace" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=shaharsha.claude-tower">
    <img src="https://img.shields.io/visual-studio-marketplace/d/shaharsha.claude-tower?color=green" alt="Downloads" />
  </a>
  <a href="https://github.com/shaharsha/claude-tower/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/shaharsha/claude-tower" alt="License MIT" />
  </a>
</p>

---

## The Problem

You're running 3-5 Claude Code sessions across different projects and worktrees. To check on them, you switch between windows, losing context each time. You miss approval prompts. You don't notice when agents finish or error out.

## The Solution

Claude Tower sits in your VS Code sidebar and shows every Claude Code session across all your projects, organized by status:

- **Running** — live elapsed timer, green indicator
- **Needs Attention** — approval prompts, errors
- **To Review** — completed sessions you haven't checked yet (blue, unread)
- **Recent** — sessions you reviewed in the last 2 hours
- **Done** — older completed sessions
- **New Worktrees** — worktrees created but not yet started

## Features

### Session Monitoring

All sessions across all projects in one view. Status detection uses three layers:

1. **Claude Code hooks** — definitive status from lifecycle events (`PreToolUse` -> working, `Stop` -> idle)
2. **CPU monitoring** — process CPU usage via `~/.claude/sessions/` registration files
3. **JSONL heuristics** — fallback analysis of session transcript files

Sessions auto-detect as "read" when you have them open in any VS Code window.

### Live Timers

- Running sessions show a precise elapsed counter (updates every second)
- Completed sessions show "X ago" and "took Y" duration
- Waiting sessions show "waiting Xm" with urgency indication

### One-Click Actions

- **[+] button** — New Chat, New Worktree, or Start from Linear
- **Open Chat** — click to focus the VS Code window and open the specific session
- **Remove Worktree** — right-click to clean up finished worktrees

### Linear Integration

Click [+] -> "Start from Linear" to see all your tickets instantly (single GraphQL query). Filter by team, status, or assignee. Pick a ticket and Claude Tower:

1. Creates a git worktree with the ticket branch
2. Copies configured files (`.env`, etc.)
3. Downloads ticket images and attachments
4. Opens VS Code and starts Claude Code with the full ticket context

No separate configuration steps — filters persist automatically.

### Smart Status Detection

Claude Tower installs lightweight hooks in `~/.claude/settings.json` that write status files on key lifecycle events. Combined with process CPU monitoring and JSONL analysis, status detection is reliable across:

- Long thinking pauses (30-60+ seconds)
- Tool execution (bash, agents, file edits)
- Inter-turn gaps in agentic loops
- Sessions opened from any VS Code window

## Quick Start

### Install

```
ext install shaharsha.claude-tower
```

Or search "Claude Tower" in the VS Code Extensions marketplace.

### Setup

1. Install the extension
2. Claude Tower auto-discovers your Claude Code sessions immediately
3. *(Optional)* Drag the panel to the **right sidebar** for always-visible monitoring
4. *(Optional)* Connect Linear via Settings for ticket integration

That's it. No API keys, no configuration files.

### Recommended Layout

```
+----------+----------------------------+----------+
| Explorer |       Claude Code          |  Tower   |
|  (left)  |      (editor area)         | (right)  |
|  ~200px  |       ~800px+              | ~250px   |
+----------+----------------------------+----------+
```

## Configuration

Claude Tower works with zero configuration. For power users, create a `.claude-tower/` directory in your repo:

```
your-repo/
  .claude-tower/
    config.json          <- hooks, worktree settings, PR config (commit this)
    prompt-template.md   <- custom prompt for Linear-started sessions (commit this)
```

### Example `config.json`

```jsonc
{
  "hooks": {
    "postCreate": ".claude-tower/setup.sh"
  },
  "copyFiles": [".env", ".env.local"],
  "symlinkDirs": ["node_modules"],
  "worktreeDir": "../.worktrees",
  "pr": {
    "baseBranch": "develop",
    "draft": true
  }
}
```

### Example `prompt-template.md`

```markdown
You are working on: {{title}} ({{identifier}})

Read .claude-tower/task-context.md and all referenced images.

Rules:
- Write tests first, then implement
- Run `npm run lint && npm run test` before finishing
```

## Requirements

- **VS Code** >= 1.98.0
- **Claude Code** VS Code extension (installed and authenticated)
- **git** (for worktree operations)
- **Linear Connect** VS Code extension (optional, for Linear integration)

## How It Works

Claude Tower reads:
- `~/.claude/projects/` — session JSONL transcript files
- `~/.claude/sessions/` — process registration files (PID, session ID, CWD)
- `~/.claude-tower/session-status/` — hook-written status files

No API keys. No telemetry. No data sent anywhere. The only network calls are to Linear's API (if connected).

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/shaharsha/claude-tower.git
cd claude-tower
npm install
# Press F5 in VS Code to launch Extension Development Host
```

## License

[MIT](LICENSE)
