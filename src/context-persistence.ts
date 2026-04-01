/**
 * Shared context persistence for NanoClaw groups.
 * Each group has a CONTEXT.md that agents read for prior context
 * and rewrite after each conversation to keep it current.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

const CONTEXT_FILENAME = 'CONTEXT.md';

/**
 * Read CONTEXT.md for a group. Returns empty string if not found.
 */
export function readGroupContext(groupFolder: string): string {
  try {
    const groupDir = resolveGroupFolderPath(groupFolder);
    const filePath = path.join(groupDir, CONTEXT_FILENAME);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch {
    // Invalid folder or read error — return empty
  }
  return '';
}

/**
 * Prompt to send to an agent after a conversation completes,
 * instructing it to update CONTEXT.md.
 */
export const UPDATE_CONTEXT_PROMPT =
  'Summarize the conversation that just completed and update CONTEXT.md ' +
  'in the current working directory. This file serves as shared context ' +
  'for future conversations. Rewrite the entire file to reflect the ' +
  'current state of knowledge — not a log of entries, but a living ' +
  'document of relevant context. Keep it concise.';
