/**
 * Shared context persistence for NanoClaw groups.
 * Each group has a CONTEXT.md that agents read for prior context
 * and rewrite after each conversation to keep it current.
 * Each group also has a LEARNINGS.md for accumulated patterns and rules.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

const CONTEXT_FILENAME = 'CONTEXT.md';
const LEARNINGS_FILENAME = 'LEARNINGS.md';

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
 * Read LEARNINGS.md for a group. Returns empty string if not found.
 */
export function readGroupLearnings(groupFolder: string): string {
  try {
    const groupDir = resolveGroupFolderPath(groupFolder);
    const filePath = path.join(groupDir, LEARNINGS_FILENAME);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch {
    // Invalid folder or read error — return empty
  }
  return '';
}

/**
 * Combined post-conversation prompt: update both CONTEXT.md and LEARNINGS.md
 * in a single agent invocation (saves a subprocess spawn).
 */
export const UPDATE_CONTEXT_PROMPT =
  'After the conversation that just completed, do these two things:\n\n' +
  '1. **Update CONTEXT.md** — Rewrite the entire file to reflect the current state ' +
  'of knowledge. This is shared context for future conversations. Not a log, but a ' +
  'living document. Keep it concise.\n\n' +
  '2. **Update LEARNINGS.md** — Review what happened in this conversation and update ' +
  'the learnings file. This file contains actionable rules and patterns discovered ' +
  'across conversations. Format as short, clear rules (e.g., "Always check X before Y", ' +
  '"User prefers Z approach"). Remove outdated rules. Keep it under 50 lines. ' +
  'If nothing new was learned, leave it unchanged.';

/**
 * Preamble injected into every prompt to enable sprint contracts.
 * Agents state what they will do before doing it.
 */
export const SPRINT_CONTRACT_PREAMBLE =
  'Before you begin working, briefly state your plan in 1-3 bullet points ' +
  'wrapped in <contract> tags. Example:\n' +
  '<contract>\n' +
  '- Fix the null check in processMessages()\n' +
  '- Add a unit test for the edge case\n' +
  '- Verify build passes\n' +
  '</contract>\n' +
  'Then proceed with the work.';

/**
 * Parse <contract>...</contract> from agent output.
 */
export function parseContract(text: string): string | null {
  const match = text.match(/<contract>([\s\S]*?)<\/contract>/i);
  return match ? match[1].trim() : null;
}

/**
 * Parse <verdict>...</verdict> from agent output.
 */
export function parseVerdict(text: string): string | null {
  const match = text.match(/<verdict>([\s\S]*?)<\/verdict>/i);
  return match ? match[1].trim() : null;
}
