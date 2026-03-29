import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LinearAuth } from '../linear/LinearAuth';
import { LinearService } from '../linear/LinearService';
import { TowerConfig } from '../types';

export class SettingsWebview {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly linearAuth: LinearAuth,
    private readonly linearService: LinearService,
    private readonly getProjectPath: () => string | undefined,
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'claudeTowerSettings',
      'Claude Tower Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      undefined,
      this.context.subscriptions,
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.sendInit();
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'connect-linear':
        await this.handleConnectLinear();
        break;

      case 'disconnect-linear':
        await this.handleDisconnectLinear();
        break;

      case 'select-team':
        await this.handleSelectTeam(msg.teamId);
        break;

      case 'select-project':
        await this.handleSelectProject(msg.projectId);
        break;

      case 'save-config':
        await this.handleSaveConfig(msg.config);
        break;

      case 'edit-file':
        await this.handleEditFile(msg.path);
        break;

      case 'browse-file':
        await this.handleBrowseFile(msg.field);
        break;

      case 'reset-template':
        await this.handleResetTemplate();
        break;
    }
  }

  private async handleConnectLinear(): Promise<void> {
    const ok = await this.linearAuth.connect();
    if (ok) {
      try {
        await this.linearService.initialize();
      } catch {
        // service init may fail, that's fine — teams fetch will show error
      }
    }
    this.sendInit();

    if (ok) {
      await this.loadAndSendTeams();
    }
  }

  private async handleDisconnectLinear(): Promise<void> {
    await this.linearAuth.disconnect();
    this.sendInit();
  }

  private async handleSelectTeam(teamId: string): Promise<void> {
    if (!teamId) {
      return;
    }
    try {
      const projects = await this.linearService.getProjects(teamId);
      this.panel?.webview.postMessage({ type: 'projects', projects });
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to load projects: ${err.message ?? err}`,
      );
    }
  }

  private async handleSelectProject(projectId: string): Promise<void> {
    // Project selection is persisted via save-config; nothing extra needed here.
    void projectId;
  }

  private async handleSaveConfig(partial: Partial<TowerConfig>): Promise<void> {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      vscode.window.showErrorMessage(
        'No project folder open. Cannot save config.',
      );
      return;
    }

    const configDir = path.join(projectPath, '.claude-tower');
    const configFile = path.join(configDir, 'config.json');

    let existing: TowerConfig = {};
    try {
      const raw = fs.readFileSync(configFile, 'utf-8');
      existing = JSON.parse(raw);
    } catch {
      // no existing config
    }

    const merged: TowerConfig = { ...existing, ...partial };

    // Deep-merge nested objects
    if (partial.linear) {
      merged.linear = { ...existing.linear, ...partial.linear };
    }
    if (partial.hooks) {
      merged.hooks = { ...existing.hooks, ...partial.hooks };
    }
    if (partial.pr) {
      merged.pr = { ...existing.pr, ...partial.pr };
    }

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configFile, JSON.stringify(merged, null, 2), 'utf-8');

    // Persist notification settings to VS Code extension configuration
    const vsConfig = vscode.workspace.getConfiguration('claude-tower');
    if ((partial as any).notifications) {
      const n = (partial as any).notifications;
      if (n.waiting !== undefined) {
        await vsConfig.update('notifications.waiting', n.waiting, vscode.ConfigurationTarget.Global);
      }
      if (n.done !== undefined) {
        await vsConfig.update('notifications.done', n.done, vscode.ConfigurationTarget.Global);
      }
      if (n.error !== undefined) {
        await vsConfig.update('notifications.error', n.error, vscode.ConfigurationTarget.Global);
      }
      if (n.pollInterval !== undefined) {
        // Convert seconds (UI) to milliseconds (config key)
        await vsConfig.update('pollIntervalMs', n.pollInterval * 1000, vscode.ConfigurationTarget.Global);
      }
    }

    vscode.window.showInformationMessage('Claude Tower settings saved.');
  }

  private async handleEditFile(filePath: string): Promise<void> {
    if (!filePath) {
      return;
    }
    const resolved = this.resolvePath(filePath);
    if (fs.existsSync(resolved)) {
      const doc = await vscode.workspace.openTextDocument(resolved);
      await vscode.window.showTextDocument(doc);
    } else {
      vscode.window.showWarningMessage(`File not found: ${resolved}`);
    }
  }

  private async handleBrowseFile(field: string): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select file',
    });

    if (uris && uris.length > 0) {
      this.panel?.webview.postMessage({
        type: 'file-selected',
        field,
        path: uris[0].fsPath,
      });
    }
  }

  private async handleResetTemplate(): Promise<void> {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      return;
    }

    const customTemplate = path.join(
      projectPath,
      '.claude-tower',
      'prompt-template.md',
    );
    if (fs.existsSync(customTemplate)) {
      fs.unlinkSync(customTemplate);
      vscode.window.showInformationMessage(
        'Prompt template reset to default.',
      );
    }
    this.sendInit();
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async sendInit(): Promise<void> {
    const config = this.loadConfig();
    const vsConfig = vscode.workspace.getConfiguration('claude-tower');

    this.panel?.webview.postMessage({
      type: 'init',
      config,
      linearConnected: this.linearAuth.isConnected(),
      linearAccount: this.linearAuth.getAccountLabel(),
      notifications: {
        waiting: vsConfig.get<boolean>('notifications.waiting', true),
        done: vsConfig.get<boolean>('notifications.done', true),
        error: vsConfig.get<boolean>('notifications.error', true),
        pollInterval: Math.round((vsConfig.get<number>('pollIntervalMs', 3000)) / 1000),
      },
      templatePath: this.getTemplatePath(),
    });
  }

  private async loadAndSendTeams(): Promise<void> {
    try {
      const teams = await this.linearService.getTeams();
      this.panel?.webview.postMessage({ type: 'teams', teams });

      // If a team is already selected, also load its projects
      const config = this.loadConfig();
      if (config.linear?.teamId) {
        const projects = await this.linearService.getProjects(
          config.linear.teamId,
        );
        this.panel?.webview.postMessage({ type: 'projects', projects });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Failed to load Linear teams: ${err.message ?? err}`,
      );
    }
  }

  private loadConfig(): TowerConfig {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      return {};
    }
    const configFile = path.join(projectPath, '.claude-tower', 'config.json');
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  private getTemplatePath(): string {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      return '(no project open)';
    }
    const custom = path.join(
      projectPath,
      '.claude-tower',
      'prompt-template.md',
    );
    if (fs.existsSync(custom)) {
      return custom;
    }
    return '(default)';
  }

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    const projectPath = this.getProjectPath();
    if (projectPath) {
      return path.join(projectPath, filePath);
    }
    return filePath;
  }

  // ------------------------------------------------------------------
  // HTML
  // ------------------------------------------------------------------

  private getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Claude Tower Settings</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 24px 16px;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 24px;
      color: var(--vscode-foreground);
    }
    .section {
      margin-bottom: 8px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      padding-bottom: 16px;
    }
    .section:last-child {
      border-bottom: none;
    }
    .section-title {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
      gap: 12px;
    }
    .row label {
      flex: 0 0 160px;
      font-size: 13px;
      color: var(--vscode-foreground);
    }
    .row .field {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    input[type="text"],
    input[type="number"],
    select {
      width: 100%;
      padding: 4px 8px;
      font-size: 13px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      outline: none;
    }
    input[type="text"]:focus,
    input[type="number"]:focus,
    select:focus {
      border-color: var(--vscode-focusBorder);
    }
    input[type="checkbox"] {
      accent-color: var(--vscode-button-background);
    }
    button {
      padding: 4px 12px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 10px;
    }
    .status-badge.connected {
      color: var(--vscode-testing-iconPassed, #73c991);
    }
    .status-badge.disconnected {
      color: var(--vscode-descriptionForeground);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-dot.on {
      background: var(--vscode-testing-iconPassed, #73c991);
    }
    .status-dot.off {
      background: var(--vscode-descriptionForeground);
    }
    .hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }
    .template-path {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family);
      word-break: break-all;
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Claude Tower Settings</h1>

    <!-- Linear Integration -->
    <div class="section">
      <div class="section-title">Linear Integration</div>
      <div class="row">
        <label>Connection</label>
        <div class="field">
          <span id="linear-status" class="status-badge disconnected">
            <span class="status-dot off"></span> Not connected
          </span>
          <button id="btn-connect" onclick="connectLinear()">Connect</button>
        </div>
      </div>
      <div id="linear-options" style="display:none;">
        <p class="hint">Use the + button → "Start from Linear" to pick tickets directly.</p>
      </div>
    </div>

    <!-- Hooks -->
    <div class="section">
      <div class="section-title">Hooks</div>
      <div class="row">
        <label>Post-create script</label>
        <div class="field">
          <input type="text" id="input-hook-post-create" placeholder="path/to/script.sh" />
          <button class="secondary" onclick="editFile('input-hook-post-create')">Edit</button>
          <button class="secondary" onclick="browseFile('hooks.postCreate')">Browse</button>
        </div>
      </div>
      <div class="row">
        <label>Pre-archive script</label>
        <div class="field">
          <input type="text" id="input-hook-pre-archive" placeholder="path/to/script.sh" />
          <button class="secondary" onclick="editFile('input-hook-pre-archive')">Edit</button>
          <button class="secondary" onclick="browseFile('hooks.preArchive')">Browse</button>
        </div>
      </div>
    </div>

    <!-- Worktree Setup -->
    <div class="section">
      <div class="section-title">Worktree Setup</div>
      <div class="row">
        <label>Copy files</label>
        <div class="field">
          <input type="text" id="input-copy-files" placeholder=".env, .env.local" />
        </div>
      </div>
      <div class="hint" style="margin-left:172px; margin-bottom:10px;">Comma-separated file paths to copy into new worktrees</div>
      <div class="row">
        <label>Symlink dirs</label>
        <div class="field">
          <input type="text" id="input-symlink-dirs" placeholder="node_modules, .next" />
        </div>
      </div>
      <div class="hint" style="margin-left:172px; margin-bottom:10px;">Comma-separated directories to symlink into new worktrees</div>
      <div class="row">
        <label>Worktree directory</label>
        <div class="field">
          <input type="text" id="input-worktree-dir" placeholder="../.worktrees" />
        </div>
      </div>
    </div>

    <!-- Pull Requests -->
    <div class="section">
      <div class="section-title">Pull Requests</div>
      <div class="row">
        <label>Base branch</label>
        <div class="field">
          <input type="text" id="input-base-branch" placeholder="main" />
        </div>
      </div>
      <div class="row">
        <label>Draft PRs</label>
        <div class="field">
          <input type="checkbox" id="chk-draft-pr" />
          <span style="font-size:12px; color:var(--vscode-descriptionForeground);">Create pull requests as drafts</span>
        </div>
      </div>
    </div>

    <!-- Prompt Template -->
    <div class="section">
      <div class="section-title">Prompt Template</div>
      <div class="template-path" id="template-path">(default)</div>
      <div style="display:flex; gap:6px;">
        <button class="secondary" onclick="editTemplate()">Edit</button>
        <button class="secondary" onclick="resetTemplate()">Reset to default</button>
      </div>
    </div>

    <!-- Notifications -->
    <div class="section">
      <div class="section-title">Notifications</div>
      <div class="row">
        <label>Waiting for input</label>
        <div class="field">
          <input type="checkbox" id="chk-notify-waiting" checked />
        </div>
      </div>
      <div class="row">
        <label>Task done</label>
        <div class="field">
          <input type="checkbox" id="chk-notify-done" checked />
        </div>
      </div>
      <div class="row">
        <label>Errors</label>
        <div class="field">
          <input type="checkbox" id="chk-notify-error" checked />
        </div>
      </div>
      <div class="row">
        <label>Poll interval (sec)</label>
        <div class="field">
          <input type="number" id="input-poll-interval" min="1" max="60" value="5" style="width:80px;" />
        </div>
      </div>
    </div>

    <!-- Save -->
    <div style="margin-top:16px; text-align:right;">
      <button onclick="saveAll()">Save Settings</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let currentConfig = {};

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          applyInit(msg);
          break;
        case 'teams':
          populateTeams(msg.teams);
          break;
        case 'projects':
          populateProjects(msg.projects);
          break;
        case 'file-selected':
          onFileSelected(msg.field, msg.path);
          break;
      }
    });

    function applyInit(msg) {
      currentConfig = msg.config || {};
      const connected = msg.linearConnected;
      const account = msg.linearAccount || '';

      // Linear status
      const statusEl = document.getElementById('linear-status');
      const btnConnect = document.getElementById('btn-connect');
      const linearOpts = document.getElementById('linear-options');

      if (connected) {
        statusEl.className = 'status-badge connected';
        statusEl.innerHTML = '<span class="status-dot on"></span> Connected as ' + escapeHtml(account);
        btnConnect.textContent = 'Disconnect';
        btnConnect.onclick = () => disconnectLinear();
        linearOpts.style.display = 'block';
      } else {
        statusEl.className = 'status-badge disconnected';
        statusEl.innerHTML = '<span class="status-dot off"></span> Not connected';
        btnConnect.textContent = 'Connect';
        btnConnect.onclick = () => connectLinear();
        linearOpts.style.display = 'none';
      }

      // Hooks
      document.getElementById('input-hook-post-create').value = currentConfig.hooks?.postCreate || '';
      document.getElementById('input-hook-pre-archive').value = currentConfig.hooks?.preArchive || '';

      // Worktree
      document.getElementById('input-copy-files').value = (currentConfig.copyFiles || []).join(', ');
      document.getElementById('input-symlink-dirs').value = (currentConfig.symlinkDirs || []).join(', ');
      document.getElementById('input-worktree-dir').value = currentConfig.worktreeDir || '';

      // PR
      document.getElementById('input-base-branch').value = currentConfig.pr?.baseBranch || '';
      document.getElementById('chk-draft-pr').checked = currentConfig.pr?.draft ?? false;

      // Template
      document.getElementById('template-path').textContent = msg.templatePath || '(default)';

      // Notifications
      if (msg.notifications) {
        document.getElementById('chk-notify-waiting').checked = msg.notifications.waiting;
        document.getElementById('chk-notify-done').checked = msg.notifications.done;
        document.getElementById('chk-notify-error').checked = msg.notifications.error;
        document.getElementById('input-poll-interval').value = msg.notifications.pollInterval;
      }
    }

    function onFileSelected(field, filePath) {
      if (field === 'hooks.postCreate') {
        document.getElementById('input-hook-post-create').value = filePath;
      } else if (field === 'hooks.preArchive') {
        document.getElementById('input-hook-pre-archive').value = filePath;
      }
    }

    // Actions
    function connectLinear() {
      vscode.postMessage({ type: 'connect-linear' });
    }

    function disconnectLinear() {
      vscode.postMessage({ type: 'disconnect-linear' });
    }

    function editFile(inputId) {
      const val = document.getElementById(inputId).value;
      if (val) {
        vscode.postMessage({ type: 'edit-file', path: val });
      }
    }

    function browseFile(field) {
      vscode.postMessage({ type: 'browse-file', field });
    }

    function editTemplate() {
      const path = document.getElementById('template-path').textContent;
      if (path && path !== '(default)' && path !== '(no project open)') {
        vscode.postMessage({ type: 'edit-file', path });
      }
    }

    function resetTemplate() {
      vscode.postMessage({ type: 'reset-template' });
    }

    function saveAll() {
      const config = {
        hooks: {
          postCreate: document.getElementById('input-hook-post-create').value || undefined,
          preArchive: document.getElementById('input-hook-pre-archive').value || undefined,
        },
        copyFiles: parseCommaList(document.getElementById('input-copy-files').value),
        symlinkDirs: parseCommaList(document.getElementById('input-symlink-dirs').value),
        worktreeDir: document.getElementById('input-worktree-dir').value || undefined,
        pr: {
          baseBranch: document.getElementById('input-base-branch').value || undefined,
          draft: document.getElementById('chk-draft-pr').checked,
        },
        notifications: {
          waiting: document.getElementById('chk-notify-waiting').checked,
          done: document.getElementById('chk-notify-done').checked,
          error: document.getElementById('chk-notify-error').checked,
          pollInterval: parseInt(document.getElementById('input-poll-interval').value, 10) || 5,
        },
      };

      vscode.postMessage({ type: 'save-config', config });
    }

    function parseCommaList(str) {
      if (!str || !str.trim()) return [];
      return str.split(',').map(s => s.trim()).filter(Boolean);
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}
