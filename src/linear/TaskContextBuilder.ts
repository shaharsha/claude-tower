import * as fs from 'fs/promises';
import * as path from 'path';
import { LinearTicket } from '../types';

/**
 * Prepare a `.claude-tower/` directory with task context for a Linear ticket.
 *
 * - Downloads all explicit attachments
 * - Finds and downloads inline Linear image URLs from the description
 * - Replaces remote image URLs with local paths
 * - Writes a `task-context.md` file
 * - Ensures `.claude-tower/` is gitignored
 */
export async function prepareTaskContext(
  ticket: LinearTicket,
  targetPath: string,
  accessToken: string,
): Promise<void> {
  const towerDir = path.join(targetPath, '.claude-tower');
  const attachDir = path.join(towerDir, 'attachments');

  await fs.mkdir(towerDir, { recursive: true });

  let description = ticket.description ?? '';

  // 1. Download explicit attachments
  if (ticket.attachments.length > 0) {
    await fs.mkdir(attachDir, { recursive: true });
  }
  for (const attachment of ticket.attachments) {
    const localName = sanitizeFilename(attachment.filename);
    const localPath = path.join(attachDir, localName);
    await downloadFile(attachment.url, localPath, accessToken);
  }

  // 2. Find and download inline Linear image URLs from description
  // Captures: ![alt-text](url) — alt text often has the real filename (e.g., "image.png")
  const inlineImageRegex = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^)]+)\)/g;
  let match: RegExpExecArray | null;
  const urlMap = new Map<string, string>();
  const usedNames = new Set<string>();

  // eslint-disable-next-line no-cond-assign
  while ((match = inlineImageRegex.exec(description)) !== null) {
    const altText = match[1];
    const url = match[2];
    if (urlMap.has(url)) {
      continue;
    }

    // Create attachments dir on first inline image
    if (urlMap.size === 0) {
      await fs.mkdir(attachDir, { recursive: true });
    }

    // Use alt text as filename if it has an extension, otherwise derive from URL
    let filename: string;
    if (altText && /\.\w{2,5}$/.test(altText)) {
      filename = altText;
    } else {
      const urlPart = url.split('/').pop()?.split('?')[0] ?? 'image';
      filename = /\.\w{2,5}$/.test(urlPart) ? urlPart : `${urlPart}.png`;
    }
    // Deduplicate: if name already used, add counter (image.png → image-2.png)
    let localName = sanitizeFilename(filename);
    if (usedNames.has(localName)) {
      const ext = localName.lastIndexOf('.');
      const base = ext > 0 ? localName.slice(0, ext) : localName;
      const suffix = ext > 0 ? localName.slice(ext) : '';
      let counter = 2;
      while (usedNames.has(`${base}-${counter}${suffix}`)) { counter++; }
      localName = `${base}-${counter}${suffix}`;
    }
    usedNames.add(localName);
    const localPath = path.join(attachDir, localName);

    await downloadFile(url, localPath, accessToken);
    urlMap.set(url, path.join('.claude-tower', 'attachments', localName));
  }

  // Replace remote URLs with local paths in description
  for (const [remoteUrl, localRelPath] of urlMap) {
    description = description.split(remoteUrl).join(localRelPath);
  }

  // 3. Write task-context.md
  const contextContent = buildContextMarkdown(ticket, description);
  await fs.writeFile(path.join(towerDir, 'task-context.md'), contextContent, 'utf-8');

  // 4. Ensure ephemeral files are gitignored (but NOT config.json/prompt-template.md)
  await ensureGitignore(targetPath, '.claude-tower/state.json');
  await ensureGitignore(targetPath, '.claude-tower/task-context.md');
  await ensureGitignore(targetPath, '.claude-tower/attachments/');
}

/**
 * Ensure a pattern exists in the .gitignore at `dirPath`.
 * Creates the file if it does not exist.
 */
export async function ensureGitignore(dirPath: string, pattern: string): Promise<void> {
  const gitignorePath = path.join(dirPath, '.gitignore');

  let content = '';
  try {
    content = await fs.readFile(gitignorePath, 'utf-8');
  } catch {
    // File does not exist yet; that is fine
  }

  const lines = content.split('\n');
  const trimmedPattern = pattern.trim();

  if (lines.some((line) => line.trim() === trimmedPattern)) {
    return; // Already present
  }

  // Append the pattern (ensure a trailing newline before it)
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await fs.writeFile(
    gitignorePath,
    `${content}${separator}${trimmedPattern}\n`,
    'utf-8',
  );
}

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function downloadFile(
  url: string,
  destPath: string,
  accessToken: string,
): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (url.includes('linear.app')) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      return; // Silently skip failed downloads
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destPath, buffer);
  } catch {
    // Silently skip — attachment is best-effort
  }
}

function buildContextMarkdown(ticket: LinearTicket, description: string): string {
  const lines: string[] = [];

  lines.push(`# ${ticket.identifier}: ${ticket.title}`);
  lines.push('');

  if (ticket.labels.length > 0) {
    lines.push(`**Labels:** ${ticket.labels.join(', ')}`);
  }

  if (ticket.priority !== undefined) {
    const priorityLabels = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
    const label = priorityLabels[ticket.priority] ?? `P${ticket.priority}`;
    lines.push(`**Priority:** ${label}`);
  }

  lines.push(`**URL:** ${ticket.url}`);
  lines.push('');

  if (description) {
    lines.push('## Description');
    lines.push('');
    lines.push(description);
    lines.push('');
  }

  if (ticket.acceptanceCriteria) {
    lines.push('## Acceptance Criteria');
    lines.push('');
    lines.push(ticket.acceptanceCriteria);
    lines.push('');
  }

  if (ticket.attachments.length > 0) {
    lines.push('## Attachments');
    lines.push('');
    for (const a of ticket.attachments) {
      const localName = sanitizeFilename(a.filename);
      lines.push(`- [${a.filename}](.claude-tower/attachments/${localName})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
