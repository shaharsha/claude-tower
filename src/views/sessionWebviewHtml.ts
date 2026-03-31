import * as vscode from 'vscode';

/**
 * Build the full HTML shell for the sessions webview.
 * Content is rendered dynamically via postMessage — this provides the CSS + JS scaffold.
 */
export function buildSessionsHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const codiconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
  );

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <link href="${codiconUri}" rel="stylesheet" />
  <style nonce="${nonce}">
    /* ── Reset ───────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: transparent;
      line-height: 1.4;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Container ───────────────────────────────────────── */
    .container {
      padding: 4px 8px 16px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    /* ── Loading state ───────────────────────────────────── */
    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .loading .codicon { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Empty state ─────────────────────────────────────── */
    .empty {
      text-align: center;
      padding: 32px 16px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    /* ── Group ───────────────────────────────────────────── */
    .group { margin-bottom: 4px; }

    .group-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 6px;
      cursor: pointer;
      user-select: none;
      border-radius: 4px;
      transition: background 150ms ease;
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .group-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .group-chevron {
      font-size: 12px;
      transition: transform 200ms ease;
      color: var(--vscode-descriptionForeground);
    }
    .group-header[data-collapsed="true"] .group-chevron {
      transform: rotate(-90deg);
    }

    .group-icon {
      font-size: 14px;
      flex-shrink: 0;
    }
    .group-icon.running       { color: var(--vscode-charts-green, #4ade80); }
    .group-icon.needs-attention { color: var(--vscode-charts-yellow, #fbbf24); }
    .group-icon.to-review     { color: var(--vscode-charts-blue, #60a5fa); }
    .group-icon.new-worktrees { color: var(--vscode-charts-purple, #a78bfa); }
    .group-icon.recent        { color: var(--vscode-descriptionForeground); }
    .group-icon.done          { color: var(--vscode-disabledForeground); }

    .group-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      flex: 1;
    }

    .group-count {
      font-size: 10px;
      font-weight: 600;
      min-width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .group-items {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 2px 0 0;
      overflow: hidden;
      transition: max-height 200ms ease, opacity 150ms ease;
    }
    .group-items.collapsed {
      max-height: 0 !important;
      opacity: 0;
      padding: 0;
    }

    /* ── Session card ────────────────────────────────────── */
    .session-card {
      display: flex;
      align-items: stretch;
      border-radius: 5px;
      cursor: pointer;
      transition: background 120ms ease;
      position: relative;
      overflow: hidden;
    }
    .session-card:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .card-accent {
      width: 3px;
      flex-shrink: 0;
      border-radius: 3px 0 0 3px;
      transition: opacity 200ms ease;
    }

    .card-content {
      flex: 1;
      min-width: 0;
      padding: 7px 8px 7px 9px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 18px;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .card-title {
      flex: 1;
      min-width: 0;
      font-size: 12.5px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-foreground);
    }

    .card-actions {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 0;
      opacity: 0;
      transition: opacity 120ms ease;
      flex-shrink: 0;
      padding: 0 4px;
      align-self: stretch;
    }
    .session-card:hover .card-actions,
    .ready-card:hover .card-actions { opacity: 1; }

    .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 14px;
      transition: background 100ms ease;
    }
    .action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }

    .card-description {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding-left: 13px;
    }

    /* ── Status colors ───────────────────────────────────── */
    .session-card.working .card-accent { background: var(--vscode-charts-green, #4ade80); }
    .session-card.working .status-dot  { background: var(--vscode-charts-green, #4ade80); }

    .session-card.waiting .card-accent { background: var(--vscode-charts-yellow, #fbbf24); }
    .session-card.waiting .status-dot  { background: var(--vscode-charts-yellow, #fbbf24); }

    .session-card.error .card-accent { background: var(--vscode-charts-red, #f87171); }
    .session-card.error .status-dot  { background: var(--vscode-charts-red, #f87171); }

    .session-card.to-review .card-accent { background: var(--vscode-charts-blue, #60a5fa); }
    .session-card.to-review .status-dot  { background: var(--vscode-charts-blue, #60a5fa); }

    .session-card.done .card-accent { background: var(--vscode-disabledForeground, #6b7280); opacity: 0.4; }
    .session-card.done .status-dot  { background: var(--vscode-disabledForeground, #6b7280); opacity: 0.5; }


    /* ── Ready worktree card ─────────────────────────────── */
    .ready-card {
      display: flex;
      align-items: stretch;
      border-radius: 5px;
      cursor: pointer;
      transition: background 120ms ease;
      overflow: hidden;
    }
    .ready-card:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .ready-card .card-accent {
      background: var(--vscode-charts-purple, #a78bfa);
    }
    .ready-card .status-dot {
      background: var(--vscode-charts-purple, #a78bfa);
    }

    /* ── Load more button ────────────────────────────────── */
    .load-more {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px 6px 20px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      border-radius: 4px;
      border: none;
      background: transparent;
      width: 100%;
      text-align: left;
      transition: background 120ms ease, color 120ms ease;
    }
    .load-more:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .load-more .codicon { font-size: 14px; }

    /* ── Context menu ────────────────────────────────────── */
    .context-menu {
      position: fixed;
      background: var(--vscode-menu-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border, transparent));
      border-radius: 6px;
      padding: 4px;
      min-width: 160px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      z-index: 1000;
      display: none;
    }
    .context-menu.visible { display: block; }
    .context-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 10px;
      font-size: 12px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      border-radius: 4px;
      cursor: pointer;
      border: none;
      background: transparent;
      width: 100%;
      text-align: left;
    }
    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
    }
    .context-menu-item .codicon { font-size: 14px; }
    .context-menu-sep {
      height: 1px;
      background: var(--vscode-menu-separatorBackground, var(--vscode-dropdown-border, rgba(128,128,128,0.2)));
      margin: 4px 8px;
    }

  </style>
</head>
<body>
  <div class="container" id="root">
    <div class="loading">
      <span class="codicon codicon-sync"></span>
      Loading sessions...
    </div>
  </div>

  <div class="context-menu" id="contextMenu"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const contextMenuEl = document.getElementById('contextMenu');

    let currentGroups = [];
    let collapsedGroups = new Set();

    // ── Restore persisted state ─────────────────────────
    const saved = vscode.getState();
    if (saved && saved.collapsedGroups) {
      collapsedGroups = new Set(saved.collapsedGroups);
    }

    function saveState() {
      vscode.setState({ collapsedGroups: [...collapsedGroups] });
    }

    // ── Message handler ─────────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'render') {
        currentGroups = msg.groups;
        render(msg.groups, msg.loading);
      } else if (msg.type === 'tick') {
        for (const u of msg.updates) {
          const el = document.querySelector('[data-desc-id="' + u.id + '"]');
          if (el) el.textContent = u.description;
        }
      }
    });

    // ── Render ───────────────────────────────────────────
    function render(groups, loading) {
      const scrollTop = root.scrollTop;

      if (loading) {
        root.innerHTML = '<div class="loading"><span class="codicon codicon-sync"></span>Loading sessions...</div>';
        return;
      }

      if (!groups || groups.length === 0) {
        root.innerHTML = '<div class="empty">No sessions found</div>';
        return;
      }

      let html = '';

      for (const group of groups) {
        const collapsed = collapsedGroups.has(group.name);
        html += '<div class="group">';
        html += '<div class="group-header" data-group="' + esc(group.name) + '" data-collapsed="' + collapsed + '">';
        html += '  <span class="group-chevron codicon codicon-chevron-down"></span>';
        html += '  <span class="group-icon ' + esc(group.color) + ' codicon codicon-' + esc(group.icon) + '"></span>';
        html += '  <span class="group-label">' + esc(group.name) + '</span>';
        html += '  <span class="group-count">' + group.count + '</span>';
        html += '</div>';
        html += '<div class="group-items' + (collapsed ? ' collapsed' : '') + '">';

        for (const item of group.items) {
          if ('type' in item && item.type === 'loadMore') {
            html += '<button class="load-more" data-action="loadMore">';
            html += '  <span class="codicon codicon-ellipsis"></span>';
            html += '  Load ' + Math.min(item.remaining, 20) + ' more... <span style="margin-left:auto;opacity:0.6">' + item.remaining + ' remaining</span>';
            html += '</button>';
          } else if ('type' in item && item.type === 'ready') {
            html += buildReadyCard(item);
          } else {
            html += buildSessionCard(item);
          }
        }

        html += '</div></div>';
      }

      root.innerHTML = html;
      root.scrollTop = scrollTop;
    }

    function buildSessionCard(item) {
      const statusClass = item.status === 'done' || item.status === 'idle' ? 'done' : item.status;
      // Apply to-review class for items in the To Review group
      const cssClass = item.toReview ? 'to-review' : statusClass;
      let h = '<div class="session-card ' + esc(cssClass) + '" ';
      h += 'data-session-id="' + esc(item.id) + '" ';
      h += 'data-worktree="' + esc(item.worktreePath) + '" ';
      h += 'title="' + esc(item.tooltip || '') + '">';
      h += '<div class="card-accent"></div>';
      h += '<div class="card-content">';
      h += '<div class="card-header">';
      h += '  <span class="status-dot"></span>';
      h += '  <span class="card-title">' + esc(item.summary) + '</span>';
      h += '</div>';
      h += '<div class="card-description" data-desc-id="' + esc(item.id) + '">' + esc(item.description) + '</div>';
      h += '</div>';
      h += '<div class="card-actions">';
      if (item.showOpen) {
        h += '<button class="action-btn" data-action="openSession" title="Open Chat"><span class="codicon codicon-arrow-right"></span></button>';
      }
      if (item.showShip) {
        h += '<button class="action-btn" data-action="shipSession" title="Ship"><span class="codicon codicon-rocket"></span></button>';
      }
      h += '</div>';
      h += '</div>';
      return h;
    }

    function buildReadyCard(item) {
      let h = '<div class="ready-card" data-worktree="' + esc(item.worktreePath) + '">';
      h += '<div class="card-accent"></div>';
      h += '<div class="card-content">';
      h += '<div class="card-header">';
      h += '  <span class="status-dot"></span>';
      h += '  <span class="card-title">' + esc(item.label) + '</span>';
      h += '</div>';
      h += '<div class="card-description">' + esc(item.description) + '</div>';
      h += '</div>';
      h += '<div class="card-actions">';
      h += '  <button class="action-btn" data-action="newSession" title="New Chat"><span class="codicon codicon-comment-discussion"></span></button>';
      h += '</div>';
      h += '</div>';
      return h;
    }

    function esc(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Click handlers ──────────────────────────────────
    root.addEventListener('click', (e) => {
      closeContextMenu();
      const target = e.target;

      // Group header toggle
      const header = target.closest('.group-header');
      if (header) {
        const name = header.dataset.group;
        const isCollapsed = header.dataset.collapsed === 'true';
        header.dataset.collapsed = String(!isCollapsed);
        const items = header.nextElementSibling;
        if (items) items.classList.toggle('collapsed', !isCollapsed);
        if (!isCollapsed) collapsedGroups.add(name);
        else collapsedGroups.delete(name);
        saveState();
        return;
      }

      // Action buttons
      const btn = target.closest('.action-btn');
      if (btn) {
        const action = btn.dataset.action;
        const card = btn.closest('.session-card, .ready-card');
        if (!card) return;
        const sessionId = card.dataset.sessionId;
        const worktreePath = card.dataset.worktree;
        vscode.postMessage({ type: action, worktreePath, sessionId, label: card.querySelector('.card-title')?.textContent });
        return;
      }

      // Load more
      const loadMore = target.closest('.load-more');
      if (loadMore) {
        vscode.postMessage({ type: 'loadMore' });
        return;
      }

    });

    // Double-click → open session / worktree
    root.addEventListener('dblclick', (e) => {
      const btn = e.target.closest('.action-btn, .load-more, .group-header');
      if (btn) return; // handled by single click

      const sessionCard = e.target.closest('.session-card');
      if (sessionCard) {
        vscode.postMessage({
          type: 'openSession',
          worktreePath: sessionCard.dataset.worktree,
          sessionId: sessionCard.dataset.sessionId,
        });
        return;
      }

      const readyCard = e.target.closest('.ready-card');
      if (readyCard) {
        vscode.postMessage({
          type: 'openWorktree',
          worktreePath: readyCard.dataset.worktree,
        });
      }
    });

    // ── Context menu ────────────────────────────────────
    root.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.session-card, .ready-card');
      if (!card) { closeContextMenu(); return; }
      e.preventDefault();

      const isSession = card.classList.contains('session-card');
      const worktreePath = card.dataset.worktree;
      const sessionId = card.dataset.sessionId;
      const label = card.querySelector('.card-title')?.textContent || '';

      let items = '';
      if (isSession) {
        items += '<button class="context-menu-item" data-ctx-action="openSession"><span class="codicon codicon-arrow-right"></span>Open Chat</button>';
        if (!card.classList.contains('working') && !card.classList.contains('waiting')) {
          items += '<button class="context-menu-item" data-ctx-action="shipSession"><span class="codicon codicon-rocket"></span>Ship</button>';
        }
        items += '<div class="context-menu-sep"></div>';
      }
      items += '<button class="context-menu-item" data-ctx-action="removeWorktree"><span class="codicon codicon-trash"></span>Remove Worktree</button>';

      contextMenuEl.innerHTML = items;
      contextMenuEl.classList.add('visible');
      contextMenuEl.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
      contextMenuEl.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
      contextMenuEl.dataset.worktree = worktreePath;
      contextMenuEl.dataset.sessionId = sessionId || '';
      contextMenuEl.dataset.label = label;
    });

    contextMenuEl.addEventListener('click', (e) => {
      const item = e.target.closest('.context-menu-item');
      if (!item) return;
      const action = item.dataset.ctxAction;
      vscode.postMessage({
        type: action,
        worktreePath: contextMenuEl.dataset.worktree,
        sessionId: contextMenuEl.dataset.sessionId,
        label: contextMenuEl.dataset.label,
      });
      closeContextMenu();
    });

    function closeContextMenu() {
      contextMenuEl.classList.remove('visible');
    }
    document.addEventListener('click', (e) => {
      if (!contextMenuEl.contains(e.target)) closeContextMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeContextMenu();
    });
  </script>
</body>
</html>`;
}
