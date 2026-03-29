import * as fs from 'fs';
import type { JsonlEvent } from '../types';

/**
 * Read the last `bytes` of a JSONL file. If the read starts mid-file,
 * the first (likely partial) line is discarded. Each remaining line is
 * parsed as JSON; unparseable lines are silently skipped.
 */
export async function readJsonlTail(
  filePath: string,
  bytes: number = 8192,
): Promise<JsonlEvent[]> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const stat = await fh.stat();
    const fileSize = stat.size;

    if (fileSize === 0) {
      return [];
    }

    const readSize = Math.min(bytes, fileSize);
    const offset = fileSize - readSize;
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, offset);

    let text = buf.toString('utf-8');

    // If we didn't start at the beginning, skip the first partial line
    if (offset > 0) {
      const newlineIdx = text.indexOf('\n');
      if (newlineIdx !== -1) {
        text = text.slice(newlineIdx + 1);
      } else {
        // Entire buffer is one partial line
        return [];
      }
    }

    return parseLines(text);
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

/**
 * Read the first `bytes` of a JSONL file. The last (likely partial)
 * line is discarded if the file is larger than `bytes`.
 */
export async function readJsonlHead(
  filePath: string,
  bytes: number = 1024,
): Promise<JsonlEvent[]> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const stat = await fh.stat();
    const fileSize = stat.size;

    if (fileSize === 0) {
      return [];
    }

    const readSize = Math.min(bytes, fileSize);
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, 0);

    let text = buf.toString('utf-8');

    // If we didn't read the whole file, drop the last partial line
    if (readSize < fileSize) {
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline !== -1) {
        text = text.slice(0, lastNewline);
      } else {
        // No complete line in buffer
        return [];
      }
    }

    return parseLines(text);
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

function parseLines(text: string): JsonlEvent[] {
  const results: JsonlEvent[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed != null && typeof parsed === 'object') {
        results.push(parsed as JsonlEvent);
      }
    } catch {
      // skip unparseable lines
    }
  }

  return results;
}
