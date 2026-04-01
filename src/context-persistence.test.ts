import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { readGroupContext, UPDATE_CONTEXT_PROMPT } from './context-persistence.js';

// Mock group-folder to use temp dirs
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => path.join(testDir, folder),
}));

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('readGroupContext', () => {
  it('returns empty string when no CONTEXT.md exists', () => {
    fs.mkdirSync(path.join(testDir, 'test-group'), { recursive: true });
    expect(readGroupContext('test-group')).toBe('');
  });

  it('returns file content when CONTEXT.md exists', () => {
    const groupDir = path.join(testDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CONTEXT.md'), 'Previous context here');
    expect(readGroupContext('test-group')).toBe('Previous context here');
  });

  it('trims whitespace from content', () => {
    const groupDir = path.join(testDir, 'test-group');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CONTEXT.md'), '  content with spaces  \n\n');
    expect(readGroupContext('test-group')).toBe('content with spaces');
  });

  it('returns empty string for nonexistent group folder', () => {
    expect(readGroupContext('nonexistent')).toBe('');
  });
});

describe('UPDATE_CONTEXT_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof UPDATE_CONTEXT_PROMPT).toBe('string');
    expect(UPDATE_CONTEXT_PROMPT.length).toBeGreaterThan(0);
  });

  it('mentions CONTEXT.md', () => {
    expect(UPDATE_CONTEXT_PROMPT).toContain('CONTEXT.md');
  });
});
