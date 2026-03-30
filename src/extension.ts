import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { TowerStateManager } from './state/TowerStateManager';
import { LinearAuth } from './linear/LinearAuth';
import { LinearService } from './linear/LinearService';
import { NotificationManager } from './notifications/NotificationManager';
import { StatusBarManager } from './statusbar/StatusBarManager';
import { SettingsWebview } from './views/SettingsWebview';
import { SessionWebviewProvider } from './views/SessionWebviewProvider';
import { installHooks, areHooksInstalled } from './state/HooksManager';

import { createWorktree as createWorktreeAction } from './actions/createWorktree';
import { getConfig } from './util/configLoader';
import { newSession } from './actions/newSession';
import { buildPromptFromTemplate } from './actions/promptTemplate';
import { copyConfiguredFiles, runHook } from './actions/hooksRunner';
import { exec, shellQuote } from './util/exec';
import { openInVSCode, focusVSCodeWindow } from './util/vscodeCli';
import { getMainBranchName } from './util/gitHelpers';
import { slugify } from './util/slugify';
import { prepareTaskContext } from './linear/TaskContextBuilder';

import type { TowerTask, LinearTicket } from './types';

// ============================================================
// Activate
// ============================================================

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // ------------------------------------------------------------------
  // 1. Register tree views IMMEDIATELY — before any async work.
  //    VS Code shows "no data provider" if views exist in package.json
  //    but providers aren't registered synchronously in activate().
  // ------------------------------------------------------------------

  const stateManager = new TowerStateManager(context);
  const sessionListProvider = new SessionWebviewProvider(stateManager, context);

  // Sessions webview views — the single control panel
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claude-tower.sessions', sessionListProvider),
    vscode.window.registerWebviewViewProvider('claude-tower.sessions-fallback', sessionListProvider),
  );

  // Set context keys synchronously
  vscode.commands.executeCommand('setContext', 'claude-tower.noSecondarySidebar', false);
  vscode.commands.executeCommand('setContext', 'claude-tower.activated', true);

  // ------------------------------------------------------------------
  // 2. Create remaining service instances
  // ------------------------------------------------------------------

  const linearAuth = new LinearAuth();
  const linearService = new LinearService(linearAuth);
  const notificationManager = new NotificationManager(context);
  const statusBarManager = new StatusBarManager();
  const settingsWebview = new SettingsWebview(
    context,
    linearAuth,
    linearService,
    getProjectPath,
  );

  // ------------------------------------------------------------------
  // 4. Listen to state changes
  // ------------------------------------------------------------------

  let previousTasks: TowerTask[] = [];

  const stateChangeDisposable = stateManager.onDidChange(() => {
    const tasks = stateManager.getTasks();

    // Update status bar
    statusBarManager.update(tasks);

    // Badge on the projects view for sessions needing attention
    let attentionCount = 0;
    for (const project of stateManager.getProjects()) {
      for (const wt of project.worktrees) {
        for (const s of wt.sessions ?? []) {
          if (s.status === 'waiting' || s.status === 'error') {
            attentionCount++;
          }
        }
      }
    }
    sessionListProvider.setBadge(
      attentionCount,
      `${attentionCount} session${attentionCount > 1 ? 's' : ''} need attention`,
    );

    // Detect notification transitions
    notificationManager.detectTransitions(previousTasks, tasks);

    previousTasks = [...tasks];
  });

  // ------------------------------------------------------------------
  // 5. Register commands
  // ------------------------------------------------------------------

  // --- Core ---

  const refreshCmd = vscode.commands.registerCommand(
    'claude-tower.refresh',
    () => stateManager.refresh(),
  );

  const loadMoreSessionsCmd = vscode.commands.registerCommand(
    'claude-tower.loadMoreSessions',
    () => sessionListProvider.loadMore(),
  );

  const shipSessionCmd = vscode.commands.registerCommand(
    'claude-tower.shipSession',
    async (arg?: any) => {
      const worktreePath = arg?._worktreePath;
      const sessionId = arg?._sessionId;
      if (!worktreePath) { return; }

      // Ship prompt: check project config → VS Code setting → default
      const config = getConfig(worktreePath);
      const projectPrompt = config?.ship?.prompt;
      const globalPrompt = vscode.workspace.getConfiguration('claude-tower').get<string>('shipPrompt');
      const prompt = projectPrompt ?? globalPrompt
        ?? 'Create a PR for the changes in this branch. Write a clear title and description based on the commits and diff.';

      // Focus or open the worktree's VS Code window
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (worktreePath !== currentWorkspace) {
        try {
          await focusVSCodeWindow(worktreePath);
        } catch {
          await openInVSCode(worktreePath, true);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Claude Code ignores ?prompt for already-open sessions, so we:
      // 1. Copy prompt to clipboard
      // 2. Focus the session
      // 3. Simulate ⌘V to paste into the input field
      await vscode.env.clipboard.writeText(prompt);

      const params = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
      const claudeUri = `vscode://anthropic.claude-code/open${params}`;
      try {
        await exec(`open ${shellQuote(claudeUri)}`, { timeout: 5000 });
      } catch {
        await vscode.env.openExternal(vscode.Uri.parse(claudeUri));
      }

      // Wait for the panel to focus, then simulate paste
      await new Promise((resolve) => setTimeout(resolve, 600));
      await exec(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { timeout: 3000 }).catch(() => {
        vscode.window.showInformationMessage('Ship prompt copied — paste with ⌘V');
      });
    },
  );

  const markReadCmd = vscode.commands.registerCommand(
    'claude-tower.markRead',
    (arg?: any) => {
      const sessionId = arg?._sessionId ?? arg?.session?.id;
      if (sessionId) {
        sessionListProvider.markRead(sessionId);
      }
    },
  );

  const newActionCmd = vscode.commands.registerCommand(
    'claude-tower.newAction',
    async () => {
      const items: vscode.QuickPickItem[] = [
        { label: '$(comment-discussion)  New Chat', description: 'Start a new Claude session' },
        { label: '$(git-branch)  New Worktree', description: 'Create a git worktree' },
      ];
      if (linearAuth.isConnected()) {
        items.push({ label: '$(bookmark)  Start from Linear', description: 'Pick a ticket and start' });
      }

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'What would you like to do?',
      });
      if (!pick) { return; }

      if (pick.label.includes('New Chat')) {
        // Pick a worktree, then start a chat
        const projects = stateManager.getProjects();
        const worktreeItems: (vscode.QuickPickItem & { path: string })[] = [];
        for (const project of projects) {
          for (const wt of project.worktrees) {
            const label = project.worktrees.length === 1
              ? project.name
              : `${project.name} / ${wt.branch}`;
            worktreeItems.push({ label, description: wt.path, path: wt.path });
          }
        }
        // If only one option, skip the picker
        let worktreePath: string | undefined;
        if (worktreeItems.length === 1) {
          worktreePath = worktreeItems[0].path;
        } else if (worktreeItems.length > 1) {
          const wtPick = await vscode.window.showQuickPick(worktreeItems, {
            placeHolder: 'Select a project / worktree',
          });
          worktreePath = wtPick?.path;
        } else {
          worktreePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        }
        if (worktreePath) {
          await newSession(worktreePath);
        }
      } else if (pick.label.includes('New Worktree')) {
        await createWorktreeAction(stateManager);
      } else if (pick.label.includes('Start from Linear')) {
        await handleStartFromLinear(undefined, stateManager, linearAuth, linearService, context);
      }
    },
  );

  const openSettingsCmd = vscode.commands.registerCommand(
    'claude-tower.openSettings',
    () => settingsWebview.show(),
  );

  // --- Start from Linear ---

  const startFromLinearCmd = vscode.commands.registerCommand(
    'claude-tower.startFromLinear',
    async (ticketArg?: LinearTicket) => {
      await handleStartFromLinear(
        ticketArg,
        stateManager,
        linearAuth,
        linearService,
        context,
      );
    },
  );

  // --- Linear connection ---

  const connectLinearCmd = vscode.commands.registerCommand(
    'claude-tower.connectLinear',
    async () => {
      const ok = await linearAuth.connect();
      if (ok) {
        try {
          await linearService.initialize();
        } catch {
          // initialization may fail; service calls will show specific errors
        }
        await stateManager.refresh();
      }
    },
  );

  const disconnectLinearCmd = vscode.commands.registerCommand(
    'claude-tower.disconnectLinear',
    () => linearAuth.disconnect(),
  );

  const configureLinearBacklogCmd = vscode.commands.registerCommand(
    'claude-tower.configureLinearBacklog',
    async () => {
      if (!linearAuth.isConnected()) {
        vscode.window.showWarningMessage('Linear is not connected. Use "Connect Linear" first.');
        return;
      }
      const projectPath = getProjectPath();
      if (!projectPath) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      await pickLinearConfig(linearAuth, linearService, projectPath);
    },
  );

  // --- Session & worktree ---

  const createWorktreeCmd = vscode.commands.registerCommand(
    'claude-tower.createWorktree',
    (arg?: any) => createWorktreeAction(stateManager, arg),
  );

  const openWorktreeCmd = vscode.commands.registerCommand(
    'claude-tower.openWorktree',
    async (arg?: any) => {
      // Resolve worktree path from various arg shapes
      let worktreePath: string | undefined;
      if (typeof arg === 'string') {
        worktreePath = arg;
      } else if (arg && typeof arg === 'object' && 'worktree' in arg) {
        worktreePath = (arg as any).worktree?.path;
      }
      if (!worktreePath) { return; }

      // Focus existing window or open a new one (never close current)
      try {
        await focusVSCodeWindow(worktreePath);
      } catch {
        await openInVSCode(worktreePath, true);
      }
    },
  );

  const openSessionCmd = vscode.commands.registerCommand(
    'claude-tower.openSession',
    async (argOrPath?: any, sessionId?: string) => {
      // Resolve args: inline action passes TreeItem, direct call passes strings
      let worktreePath: string | undefined;
      if (typeof argOrPath === 'string') {
        worktreePath = argOrPath;
      } else if (argOrPath && typeof argOrPath === 'object') {
        worktreePath = (argOrPath as any)._worktreePath;
        sessionId = sessionId ?? (argOrPath as any)._sessionId;
      }
      if (!worktreePath) { return; }

      // Mark session as read
      if (sessionId) {
        sessionListProvider.markRead(sessionId);
      }

      // Build the Claude Code URI
      const params = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
      const claudeUri = `vscode://anthropic.claude-code/open${params}`;

      // Focus existing window or open new one
      const currentWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (worktreePath !== currentWorkspace) {
        try {
          await focusVSCodeWindow(worktreePath);
        } catch {
          await openInVSCode(worktreePath, true);
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      // Use OS `open` to route the URI to the currently focused window,
      // not the extension host window (avoids duplicate tabs).
      try {
        await exec(`open ${shellQuote(claudeUri)}`, { timeout: 5000 });
      } catch {
        // Fallback to VS Code API
        await vscode.env.openExternal(vscode.Uri.parse(claudeUri));
      }
    },
  );

  const newSessionCmd = vscode.commands.registerCommand(
    'claude-tower.newSession',
    (arg?: any) => {
      let worktreePath: string | undefined;
      if (typeof arg === 'string') {
        worktreePath = arg;
      } else if (arg && typeof arg === 'object' && 'worktreePath' in arg) {
        // ReadyItem
        worktreePath = (arg as any).worktreePath;
      } else if (arg && typeof arg === 'object' && 'worktree' in arg) {
        worktreePath = (arg as any).worktree?.path;
      }
      if (!worktreePath) {
        worktreePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      }
      if (worktreePath) {
        return newSession(worktreePath);
      }
    },
  );

  const removeWorktreeCmd = vscode.commands.registerCommand(
    'claude-tower.removeWorktree',
    async (arg?: any) => {
      // Resolve worktree path from session item or ready item
      let worktreePath: string | undefined;
      let worktreeLabel: string | undefined;

      if (arg?._worktreePath) {
        // SessionListItem
        worktreePath = arg._worktreePath;
        worktreeLabel = arg.session?.summary ?? path.basename(arg._worktreePath);
      } else if (arg?.worktreePath) {
        // ReadyItem
        worktreePath = arg.worktreePath;
        worktreeLabel = arg.label ?? path.basename(arg.worktreePath);
      } else if (arg?.worktree?.path) {
        // Legacy format
        worktreePath = arg.worktree.path;
        worktreeLabel = arg.worktree.branch;
      }

      if (!worktreePath) { return; }

      const folderName = path.basename(worktreePath);
      const confirm = await vscode.window.showWarningMessage(
        `Remove worktree "${folderName}"? This will delete the folder and its branch.`,
        { modal: true },
        'Remove',
      );

      if (confirm !== 'Remove') { return; }

      // Find the git repo root for this worktree
      let repoRoot: string | undefined;
      try {
        repoRoot = (await exec(
          `git -C ${shellQuote(worktreePath)} rev-parse --path-format=absolute --git-common-dir`,
          { timeout: 5000 },
        )).trim();
        if (repoRoot?.endsWith('/.git')) { repoRoot = repoRoot.slice(0, -5); }
        else { repoRoot = path.dirname(repoRoot!); }
      } catch {
        repoRoot = getProjectPath();
      }

      if (!repoRoot) {
        vscode.window.showErrorMessage('Could not find git repository.');
        return;
      }

      try {
        await exec(`git worktree remove ${shellQuote(worktreePath)} --force`, {
          cwd: repoRoot,
        });
        stateManager.removePendingWorktree(worktreePath);
        await stateManager.refresh();
        vscode.window.showInformationMessage(
          `Worktree "${folderName}" removed.`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // --- Project management ---

  const pinProjectCmd = vscode.commands.registerCommand(
    'claude-tower.pinProject',
    async (arg?: { project?: { id: string; name: string } }) => {
      const project = (arg as any)?.project;
      if (!project?.id) {
        return;
      }

      const pinned: string[] =
        context.globalState.get('claude-tower.pinnedProjects') ?? [];
      if (!pinned.includes(project.id)) {
        pinned.push(project.id);
        await context.globalState.update('claude-tower.pinnedProjects', pinned);
        vscode.window.showInformationMessage(`Pinned "${project.name}".`);
        await stateManager.refresh();
      }
    },
  );

  const hideProjectCmd = vscode.commands.registerCommand(
    'claude-tower.hideProject',
    async (arg?: { project?: { id: string; name: string } }) => {
      const project = (arg as any)?.project;
      if (!project?.id) {
        return;
      }

      const hidden: string[] =
        context.globalState.get('claude-tower.hiddenProjects') ?? [];
      if (!hidden.includes(project.id)) {
        hidden.push(project.id);
        await context.globalState.update('claude-tower.hiddenProjects', hidden);
        vscode.window.showInformationMessage(`Hidden "${project.name}".`);
        await stateManager.refresh();
      }
    },
  );

  // ------------------------------------------------------------------
  // 6. Activate state manager (starts polling)
  // ------------------------------------------------------------------

  // Install Claude Code hooks for definitive session status tracking
  if (!areHooksInstalled()) {
    try {
      installHooks();
    } catch (err) {
      console.warn('[claude-tower] Failed to install hooks:', err);
    }
  }

  stateManager.activate();

  // ------------------------------------------------------------------
  // 7. Restore Linear connection from stored session
  // ------------------------------------------------------------------

  try {
    const session = await vscode.authentication.getSession(
      'linear',
      ['read', 'write'],
      { createIfNone: false },
    );
    if (session) {
      await linearAuth.connect();
      try {
        await linearService.initialize();
      } catch {
        // Initialization may fail if token is stale
      }
    }
  } catch {
    // No prior session
  }

  // ------------------------------------------------------------------
  // 8. Focus Claude Tower in the secondary sidebar on startup
  // ------------------------------------------------------------------

  const focusTower = () => {
    vscode.commands.executeCommand('claude-tower.sessions.focus').then(
      () => {},
      () => {},
    );
  };
  focusTower();
  setTimeout(focusTower, 500);
  setTimeout(focusTower, 1500);
  setTimeout(focusTower, 3000);

  // ------------------------------------------------------------------
  // 9. Push all disposables to context.subscriptions
  // ------------------------------------------------------------------

  context.subscriptions.push(
    // View providers
    { dispose: () => sessionListProvider.dispose() },

    // State change listener
    stateChangeDisposable,

    // Core commands
    refreshCmd,
    loadMoreSessionsCmd,
    shipSessionCmd,
    markReadCmd,
    newActionCmd,
    openSettingsCmd,

    // Linear commands
    startFromLinearCmd,
    connectLinearCmd,
    disconnectLinearCmd,
    configureLinearBacklogCmd,

    // Session & worktree commands
    createWorktreeCmd,
    openWorktreeCmd,
    openSessionCmd,
    newSessionCmd,
    removeWorktreeCmd,

    // Project commands
    pinProjectCmd,
    hideProjectCmd,

    // Services
    { dispose: () => stateManager.deactivate() },
    { dispose: () => statusBarManager.dispose() },
    { dispose: () => notificationManager.dispose() },
  );
}

// ============================================================
// Deactivate
// ============================================================

export function deactivate(): void {
  // All cleanup is handled via context.subscriptions disposables
  // registered in activate().
}

// ============================================================
// Helpers
// ============================================================

/**
 * Returns the filesystem path of the first workspace folder, or undefined.
 */
function getProjectPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Sync task status changes back to Linear using reverse status mapping.
 */
/**
 * Handle the "Start from Linear" command:
 * - Pick a ticket from the backlog
 * - Create worktree with branch from ticket
 * - Prepare task context and prompt
 * - Open VS Code window and send prompt
 */
async function handleStartFromLinear(
  ticketArg: LinearTicket | undefined,
  stateManager: TowerStateManager,
  linearAuth: LinearAuth,
  linearService: LinearService,
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!linearAuth.isConnected()) {
    const connect = await vscode.window.showWarningMessage(
      'Linear is not connected.',
      'Connect Linear',
    );
    if (connect) {
      const ok = await linearAuth.connect();
      if (ok) {
        try { await linearService.initialize(); } catch {}
      }
    }
    if (!linearAuth.isConnected()) { return; }
  }

  // Pick which project/repo to create the worktree in
  let projectPath: string | undefined;
  const projects = stateManager.getProjects().filter((p) => p.worktrees.length > 0);
  if (projects.length === 0) {
    projectPath = getProjectPath();
    if (!projectPath) {
      vscode.window.showErrorMessage('No project found.');
      return;
    }
  } else if (projects.length === 1) {
    projectPath = projects[0].path;
  } else {
    const picked = await vscode.window.showQuickPick(
      projects.map((p) => ({ label: p.name, detail: p.path, path: p.path })),
      { placeHolder: 'Which project?', title: 'Start from Linear' },
    );
    if (!picked) { return; }
    projectPath = picked.path;
  }

  let ticket = ticketArg;

  if (!ticket) {
    const allTickets = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Fetching Linear tickets...',
      },
      () => linearService.getAllTickets(),
    );

    if (allTickets.length === 0) {
      vscode.window.showInformationMessage('No tickets found in Linear.');
      return;
    }

    const teams = [...new Set(allTickets.map((t) => t.teamName))].sort();
    const statuses = [...new Set(allTickets.map((t) => t.state))].sort();
    const assignees = [...new Set(allTickets.map((t) => t.assignee).filter(Boolean) as string[])].sort();

    ticket = await showLinearTicketPicker(allTickets, teams, statuses, assignees, context);
    if (!ticket) { return; }
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Starting: ${ticket.identifier} ${ticket.title}`,
      cancellable: false,
    },
    async (progress) => {
      const config = getConfig(projectPath);

      // Branch from ticket
      const branchPrefix = config?.linear?.branchPrefix ?? 'feat/';
      const branch = `${branchPrefix}${ticket!.identifier}-${slugify(ticket!.title)}`;

      progress.report({ message: 'Creating worktree...' });

      const worktreeDir =
        config?.worktreeDir ||
        path.join(path.dirname(projectPath), '.worktrees');
      const worktreePath = path.join(worktreeDir, branch.replace(/\//g, '-'));
      const mainBranch = await getMainBranchName(projectPath);

      // Fetch latest from remote before branching
      progress.report({ message: 'Fetching latest...' });
      await exec(`git fetch origin ${shellQuote(mainBranch)}`, { cwd: projectPath }).catch(() => {});

      // Clean up stale worktree registrations
      await exec(`git worktree prune`, { cwd: projectPath }).catch(() => {});

      // Check if branch already exists
      let finalBranch = branch;
      let finalWorktreePath = worktreePath;
      const branchExists = await exec(
        `git rev-parse --verify ${shellQuote(branch)}`,
        { cwd: projectPath },
      ).then(() => true).catch(() => false);

      if (branchExists) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: '$(git-branch) Reuse existing branch', description: branch, value: 'reuse' },
            { label: '$(add) Create new branch', description: `${branch}-2`, value: 'new' },
          ],
          { placeHolder: `Branch "${branch}" already exists` },
        );

        if (!choice) { return; }

        if (choice.value === 'reuse') {
          await exec(
            `git worktree add ${shellQuote(worktreePath)} ${shellQuote(branch)}`,
            { cwd: projectPath },
          );
        } else {
          // Find next available suffix
          let suffix = 2;
          let newBranch = `${branch}-${suffix}`;
          while (await exec(`git rev-parse --verify ${shellQuote(newBranch)}`, { cwd: projectPath }).then(() => true).catch(() => false)) {
            suffix++;
            newBranch = `${branch}-${suffix}`;
          }
          finalBranch = newBranch;
          finalWorktreePath = path.join(worktreeDir, finalBranch.replace(/\//g, '-'));
          await exec(
            `git worktree add -b ${shellQuote(finalBranch)} ${shellQuote(finalWorktreePath)} origin/${shellQuote(mainBranch)}`,
            { cwd: projectPath },
          );
        }
      } else {
        await exec(
          `git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreePath)} origin/${shellQuote(mainBranch)}`,
          { cwd: projectPath },
        );
      }

      // Use the final paths from here
      const actualWorktreePath = finalWorktreePath;

      progress.report({ message: 'Copying files...' });
      await copyConfiguredFiles(projectPath, actualWorktreePath, config, progress);

      // Run postCreate hook
      progress.report({ message: 'Running hooks...' });
      await runHook('postCreate', { worktreePath: actualWorktreePath, branch: finalBranch, projectPath } as any, config, progress);

      // Download attachments and create task-context.md
      progress.report({ message: 'Downloading ticket context...' });
      try {
        await prepareTaskContext(ticket!, actualWorktreePath, linearAuth.getAccessToken());
      } catch (err) {
        console.warn('[claude-tower] Failed to prepare task context:', err);
      }

      // Build prompt from template
      progress.report({ message: 'Preparing prompt...' });
      const prompt = await buildPromptFromTemplate(actualWorktreePath, ticket);

      // Open VS Code window
      progress.report({ message: 'Opening VS Code...' });
      await openInVSCode(actualWorktreePath, true);
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Send prompt
      if (prompt) {
        const uri = vscode.Uri.parse(
          `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`,
        );
        await vscode.env.openExternal(uri);
      }

      // Update Linear status
      try {
        const statusMapping = config?.linear?.statusMapping;
        const linearStatus = statusMapping?.['in-progress'] ?? 'In Progress';
        await linearService.updateIssueStatus(ticket!.id, linearStatus);
      } catch {
        // non-critical
      }

      // Track as pending worktree
      stateManager.addPendingWorktree(actualWorktreePath, finalBranch, ticket!.identifier + ': ' + ticket!.title);

      await stateManager.refresh();
    },
  );
}

/**
 * Interactive ticket picker with inline filter items and free text search.
 */
async function showLinearTicketPicker(
  allTickets: (LinearTicket & { teamName: string })[],
  teams: string[],
  statuses: string[],
  assignees: string[],
  context: vscode.ExtensionContext,
): Promise<LinearTicket | undefined> {
  return new Promise<LinearTicket | undefined>((resolve) => {
    type PickItem = vscode.QuickPickItem & { ticket?: LinearTicket; filterAction?: string };

    // Restore persisted filters
    const saved = context.globalState.get<{ team: string; status: string; assignee: string }>('claude-tower.linearFilters');
    let selectedTeam = saved?.team ?? 'All';
    let selectedStatus = saved?.status ?? 'All';
    let selectedAssignee = saved?.assignee ?? 'All';
    let pickingFilter = false;
    let resolved = false;

    function saveFilters() {
      context.globalState.update('claude-tower.linearFilters', {
        team: selectedTeam,
        status: selectedStatus,
        assignee: selectedAssignee,
      });
    }

    const qp = vscode.window.createQuickPick<PickItem>();
    qp.title = 'Start from Linear';
    qp.placeholder = 'Search by title, ID, or description...';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;

    function updateItems() {
      const filtered = allTickets.filter((t) => {
        if (selectedTeam !== 'All' && t.teamName !== selectedTeam) { return false; }
        if (selectedStatus !== 'All' && t.state !== selectedStatus) { return false; }
        if (selectedAssignee === 'Me' && !t.assignee) { return false; }
        if (selectedAssignee === 'Unassigned' && t.assignee) { return false; }
        if (selectedAssignee !== 'All' && selectedAssignee !== 'Me' && selectedAssignee !== 'Unassigned'
            && t.assignee !== selectedAssignee) { return false; }
        return true;
      });

      const teamLabel = selectedTeam === 'All' ? 'All teams' : selectedTeam;
      const statusLabel = selectedStatus === 'All' ? 'All statuses' : selectedStatus;
      const assigneeLabel = selectedAssignee === 'All' ? 'Anyone' : selectedAssignee;

      const items: PickItem[] = [
        {
          label: `$(organization)  Team: ${teamLabel}`,
          alwaysShow: true,
          filterAction: 'team',
        },
        {
          label: `$(tag)  Status: ${statusLabel}`,
          alwaysShow: true,
          filterAction: 'status',
        },
        {
          label: `$(person)  Assignee: ${assigneeLabel}`,
          alwaysShow: true,
          filterAction: 'assignee',
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
      ];

      if (filtered.length === 0) {
        items.push({ label: 'No tickets match filters', description: 'Try changing filters above' });
      } else {
        items.push(
          ...filtered.map((t) => ({
            label: `${t.identifier}: ${t.title}`,
            description: `${t.teamName} · ${t.state}${t.assignee ? ` · ${t.assignee}` : ''}`,
            detail: t.description?.slice(0, 120),
            ticket: t as LinearTicket,
          })),
        );
      }

      qp.items = items;
    }

    qp.onDidAccept(async () => {
      const selected = qp.selectedItems[0];
      if (!selected) { return; }

      if (selected.filterAction === 'team') {
        pickingFilter = true;
        qp.hide();
        const pick = await vscode.window.showQuickPick(
          ['All', ...teams].map((t) => ({
            label: t === 'All' ? 'All teams' : t,
            description: (t === selectedTeam || (t === 'All' && selectedTeam === 'All')) ? '$(check)' : '',
            value: t,
          })),
          { placeHolder: 'Filter by team' },
        );
        if (pick) { selectedTeam = (pick as any).value; saveFilters(); }
        updateItems();
        qp.value = '';
        pickingFilter = false;
        qp.show();
      } else if (selected.filterAction === 'status') {
        pickingFilter = true;
        qp.hide();
        const pick = await vscode.window.showQuickPick(
          ['All', ...statuses].map((s) => ({
            label: s === 'All' ? 'All statuses' : s,
            description: (s === selectedStatus || (s === 'All' && selectedStatus === 'All')) ? '$(check)' : '',
            value: s,
          })),
          { placeHolder: 'Filter by status' },
        );
        if (pick) { selectedStatus = (pick as any).value; saveFilters(); }
        updateItems();
        qp.value = '';
        pickingFilter = false;
        qp.show();
      } else if (selected.filterAction === 'assignee') {
        pickingFilter = true;
        qp.hide();
        const assigneeOptions = ['All', 'Me', 'Unassigned', ...assignees];
        const pick = await vscode.window.showQuickPick(
          assigneeOptions.map((a) => ({
            label: a === 'All' ? 'Anyone' : a,
            description: (a === selectedAssignee || (a === 'All' && selectedAssignee === 'All')) ? '$(check)' : '',
            value: a,
          })),
          { placeHolder: 'Filter by assignee' },
        );
        if (pick) { selectedAssignee = (pick as any).value; saveFilters(); }
        updateItems();
        qp.value = '';
        pickingFilter = false;
        qp.show();
      } else if (selected.ticket) {
        resolved = true;
        resolve(selected.ticket);
        qp.dispose();
      }
    });

    qp.onDidHide(() => {
      if (!pickingFilter && !resolved) {
        resolve(undefined);
        qp.dispose();
      }
    });

    updateItems();
    qp.show();
  });
}

/**
 * Inline team/project/filter picker for Linear. Saves selections persistently.
 * Returns the LinearConfig or undefined if cancelled.
 */
async function pickLinearConfig(
  linearAuth: LinearAuth,
  linearService: LinearService,
  projectPath: string,
): Promise<import('./types').LinearConfig | undefined> {
  // Step 1: Pick team
  const teams = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading Linear teams...' },
    () => linearService.getTeams(),
  );

  if (teams.length === 0) {
    vscode.window.showInformationMessage('No Linear teams found.');
    return undefined;
  }

  const teamPick = await vscode.window.showQuickPick(
    teams.map((t) => ({ label: t.name, id: t.id })),
    { placeHolder: 'Select a team' },
  );
  if (!teamPick) { return undefined; }

  // Step 2: Pick project (optional)
  const projects = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading projects...' },
    () => linearService.getProjects(teamPick.id),
  );

  let projectId: string | undefined;
  if (projects.length > 0) {
    const projectPick = await vscode.window.showQuickPick(
      [
        { label: 'All projects', id: undefined as string | undefined },
        ...projects.map((p) => ({ label: p.name, id: p.id as string | undefined })),
      ],
      { placeHolder: 'Filter by project (optional)' },
    );
    if (projectPick) { projectId = projectPick.id; }
  }

  // Step 3: Pick filter
  const filterPick = await vscode.window.showQuickPick(
    [
      { label: 'My assigned tickets', value: 'assigned' as const },
      { label: 'All team tickets', value: 'all' as const },
      { label: 'Unassigned', value: 'unassigned' as const },
    ],
    { placeHolder: 'Ticket filter' },
  );
  if (!filterPick) { return undefined; }

  // Save persistently
  const configDir = path.join(projectPath, '.claude-tower');
  const configFile = path.join(configDir, 'config.json');

  let existing: Record<string, any> = {};
  try { existing = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch {}

  const linearConfig = {
    ...(existing.linear ?? {}),
    teamId: teamPick.id,
    projectId,
    filter: filterPick.value,
  };
  existing.linear = linearConfig;

  if (!fs.existsSync(configDir)) { fs.mkdirSync(configDir, { recursive: true }); }
  fs.writeFileSync(configFile, JSON.stringify(existing, null, 2), 'utf-8');

  return linearConfig;
}
