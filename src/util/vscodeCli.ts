import * as vscode from 'vscode';
import * as fs from 'fs';
import { exec } from './exec';

const KNOWN_PATHS = [
  '/usr/local/bin/code',
  '/opt/homebrew/bin/code',
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  '/Applications/Cursor.app/Contents/Resources/app/bin/code',
];

/**
 * Open a folder in VS Code, optionally in a new window.
 * Prefers the VS Code API (works without CLI on PATH).
 * Falls back to the `code` CLI binary.
 */
export async function openInVSCode(
  folderPath: string,
  newWindow?: boolean,
): Promise<void> {
  if (newWindow) {
    // VS Code API: open folder in new window
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(folderPath),
      { forceNewWindow: true },
    );
  } else {
    // Open in current window
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(folderPath),
    );
  }
}

/**
 * Focus an existing VS Code window for the given path.
 * Uses the `code` CLI since the VS Code API can't focus another window.
 * If the CLI is not found, falls back to openFolder which may reuse or create.
 */
export async function focusVSCodeWindow(folderPath: string): Promise<void> {
  try {
    const cli = await getVSCodeCLIPath();
    await exec(`${quote(cli)} ${quote(folderPath)}`);
  } catch {
    // CLI not found — fall back to VS Code API (may open new window)
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(folderPath),
    );
  }
}

/**
 * Locate the VS Code CLI (`code`) binary.
 */
async function getVSCodeCLIPath(): Promise<string> {
  try {
    const result = (await exec('which code', { timeout: 5000 })).trim();
    if (result) { return result; }
  } catch { /* not on PATH */ }

  for (const p of KNOWN_PATHS) {
    if (fs.existsSync(p)) { return p; }
  }

  throw new Error('VS Code CLI (code) not found.');
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
