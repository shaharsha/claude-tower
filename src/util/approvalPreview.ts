import type { JsonlEvent } from '../types';

interface ToolUse {
  id: string;
  name: string;
  input: any;
}

/**
 * Extract a human-readable preview of the last pending tool use
 * (a tool_use with no matching tool_result).
 *
 * Tool uses appear in two forms:
 * 1. Content block inside a `type:"message"` / `role:"assistant"` event,
 *    where `content` is an array containing `{type:"tool_use", id, name, input}`.
 * 2. Standalone `type:"tool_use"` event with `toolName`, `toolInput`, `toolUseId`.
 */
export function extractApprovalPreview(
  events: JsonlEvent[],
): string | undefined {
  const toolUses: ToolUse[] = [];
  const toolResultIds = new Set<string>();

  for (const event of events) {
    // Real Claude Code format: type:"assistant" with event.message.content[]
    const msg = (event as any).message;
    const content = msg?.content ?? event.content;

    if (
      (event.type === 'assistant' || (event.type === 'message' && event.role === 'assistant')) &&
      Array.isArray(content)
    ) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    }

    // Real format: type:"user" with event.message.content[] containing tool_result
    if (
      (event.type === 'user' || (event.type === 'message' && event.role === 'user')) &&
      Array.isArray(content)
    ) {
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }

    // Standalone tool_use/tool_result events (legacy/fallback)
    if (event.type === 'tool_use' && (event.toolUseId || event.tool_use_id)) {
      const id = event.toolUseId || event.tool_use_id || '';
      toolUses.push({ id, name: event.toolName || 'unknown', input: event.toolInput });
    }
    if (event.type === 'tool_result') {
      const id = (event as any).toolUseId ?? (event as any).tool_use_id ?? (event as any).id;
      if (id) { toolResultIds.add(id); }
    }
  }

  // Find the last tool_use that has no matching result
  for (let i = toolUses.length - 1; i >= 0; i--) {
    const tu = toolUses[i];
    if (!toolResultIds.has(tu.id)) {
      return formatPreview(tu.name, tu.input);
    }
  }

  return undefined;
}

function formatPreview(name: string, input: any): string {
  switch (name) {
    case 'Bash':
    case 'bash': {
      const cmd =
        typeof input === 'string'
          ? input
          : input?.command ?? input?.description ?? input?.cmd ?? '';
      const truncated =
        cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
      return `"${truncated}"`;
    }

    case 'Edit':
    case 'edit':
    case 'Write':
    case 'write': {
      const file = input?.file_path ?? input?.path ?? input?.filePath ?? '';
      return `Edit: ${file}`;
    }

    case 'Read':
    case 'read': {
      const file = input?.file_path ?? input?.path ?? input?.filePath ?? '';
      return `Read: ${file}`;
    }

    default:
      return name;
  }
}
