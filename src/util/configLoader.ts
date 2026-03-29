import * as fs from 'fs';
import * as path from 'path';
import type { TowerConfig } from '../types';

/**
 * Read and parse the .claude-tower/config.json for a project.
 * Returns null if the file is not found or cannot be parsed.
 */
export function getConfig(projectPath: string | undefined): TowerConfig | null {
  if (!projectPath) {
    return null;
  }

  const configPath = path.join(projectPath, '.claude-tower', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as TowerConfig;
  } catch {
    return null;
  }
}
