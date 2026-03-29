import * as fs from 'fs';
import * as path from 'path';
import type { LinearTicket } from '../types';

/**
 * Build a concise prompt for Claude Code from a Linear ticket.
 * Uses a project-specific template if available, otherwise generates dynamically.
 *
 * Supports custom templates at .claude-tower/prompt-template.md with:
 * - {{variable}} placeholders: title, identifier, description, labels, priority, url
 * - {{#variable}}...{{/variable}} conditional blocks: removed if variable is empty
 */
export async function buildPromptFromTemplate(
  projectPath: string,
  ticket?: LinearTicket,
): Promise<string> {
  // Try project-specific template first
  const templatePath = path.join(projectPath, '.claude-tower', 'prompt-template.md');
  try {
    const template = await fs.promises.readFile(templatePath, 'utf-8');
    return applyTemplate(template, ticket);
  } catch {
    // No custom template — build dynamic prompt
  }

  if (!ticket) { return ''; }

  // Build a clean, concise prompt
  const lines: string[] = [];

  lines.push(`You are working on: ${ticket.title}${ticket.identifier ? ` (${ticket.identifier})` : ''}`);
  lines.push('');

  // Check if task-context.md was written
  const contextPath = path.join(projectPath, '.claude-tower', 'task-context.md');
  const contextExists = fs.existsSync(contextPath);

  if (contextExists) {
    const hasImages = ticket.attachments.length > 0 ||
      (ticket.description && /!\[[^\]]*\]\(https?:\/\//.test(ticket.description));

    if (hasImages) {
      lines.push('Read the full task description and referenced images in .claude-tower/task-context.md');
    } else {
      lines.push('Read the full task description in .claude-tower/task-context.md');
    }
  }

  return lines.join('\n').trim();
}

function applyTemplate(template: string, ticket?: LinearTicket): string {
  const vars: Record<string, string> = {
    title: ticket?.title ?? 'the task',
    identifier: ticket?.identifier ?? '',
    description: ticket?.description ?? '',
    labels: ticket?.labels?.join(', ') ?? '',
    priority: ticket?.priority != null ? String(ticket.priority) : '',
    url: ticket?.url ?? '',
  };

  let result = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, varName: string, content: string) => {
      return (vars[varName] ?? '') ? content : '';
    },
  );

  result = result.replace(
    /\{\{(\w+)\}\}/g,
    (_match, varName: string) => vars[varName] ?? '',
  );

  return result.trim();
}
