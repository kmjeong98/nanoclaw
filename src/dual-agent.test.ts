import { describe, it, expect, vi } from 'vitest';

import {
  detectLeadAgent,
  stripAgentMentions,
  runDualAgent,
  DualAgentDeps,
} from './dual-agent.js';

describe('detectLeadAgent', () => {
  it('returns codex as default', () => {
    expect(detectLeadAgent('hello world')).toBe('codex');
  });

  it('detects @claude mention', () => {
    expect(detectLeadAgent('hey @claude fix this')).toBe('claude');
  });

  it('detects @Claude (case insensitive)', () => {
    expect(detectLeadAgent('@Claude do something')).toBe('claude');
  });

  it('detects @codex mention', () => {
    expect(detectLeadAgent('@codex review this')).toBe('codex');
  });

  it('uses custom default', () => {
    expect(detectLeadAgent('hello', 'claude')).toBe('claude');
  });
});

describe('stripAgentMentions', () => {
  it('removes @claude', () => {
    expect(stripAgentMentions('@claude fix this')).toBe('fix this');
  });

  it('removes @Codex', () => {
    expect(stripAgentMentions('hey @Codex review')).toBe('hey  review');
  });

  it('removes multiple mentions', () => {
    expect(stripAgentMentions('@claude and @codex work together')).toBe(
      'and  work together',
    );
  });

  it('leaves message unchanged when no mentions', () => {
    expect(stripAgentMentions('hello world')).toBe('hello world');
  });
});

describe('runDualAgent', () => {
  function makeDeps(
    responses: Array<{ result: string | null; error: string | null }>,
    userMessages: string[][] = [],
  ): DualAgentDeps & { sent: string[] } {
    let callIndex = 0;
    let userMsgIndex = 0;
    const sent: string[] = [];

    return {
      sent,
      runSingleAgent: vi.fn(async () => {
        return (
          responses[callIndex++] || { result: null, error: 'no more responses' }
        );
      }),
      sendMessage: vi.fn(async (text: string) => {
        sent.push(text);
      }),
      drainUserMessages: vi.fn(() => {
        return userMessages[userMsgIndex++] || [];
      }),
    };
  }

  it('reaches consensus when reviewer approves on first review', async () => {
    const deps = makeDeps([
      { result: 'Here is my solution', error: null },
      { result: 'I verified the solution by reading the code. The fix is correct and handles edge cases properly. All tests pass. [APPROVED]', error: null },
    ]);

    const result = await runDualAgent('fix the bug', 'codex', deps);

    expect(result.status).toBe('consensus');
    expect(result.totalTurns).toBe(2);
    expect(deps.sent.some((s) => s.includes('consensus'))).toBe(true);
  });

  it('reaches consensus with user mention when userDiscordId provided', async () => {
    const deps = makeDeps([
      { result: 'Here is my solution', error: null },
      { result: 'I checked the implementation and verified it addresses the bug correctly. The approach is sound and well-tested. [DONE]', error: null },
    ]);
    deps.userDiscordId = '123456789';

    const result = await runDualAgent('fix the bug', 'codex', deps);

    expect(result.status).toBe('consensus');
    expect(deps.sent.some((s) => s.includes('<@123456789>'))).toBe(true);
  });

  it('rejects empty reviewer approval and forces re-review', async () => {
    const deps = makeDeps([
      { result: 'Here is my solution', error: null },
      { result: '[DONE]', error: null }, // Empty — rejected
      { result: 'After re-checking: I read the file and verified the fix is correct. The null check handles the edge case. [DONE]', error: null },
    ]);

    const result = await runDualAgent('fix the bug', 'codex', deps);

    expect(result.status).toBe('consensus');
    expect(result.totalTurns).toBe(3); // 1 lead + 1 rejected + 1 proper review
  });

  it('handles feedback loop until consensus', async () => {
    const deps = makeDeps([
      { result: 'My solution v1', error: null },
      { result: 'Issue: missing error handling. I checked the code and found that processMessages does not handle null inputs.', error: null },
      { result: 'Fixed: added error handling for null inputs and wrote tests to cover the edge case. [APPROVED]', error: null },
      { result: 'I verified the fix by reading the updated code. The null check is correct and tests pass. [APPROVED]', error: null },
    ]);

    const result = await runDualAgent('fix the bug', 'codex', deps);

    expect(result.status).toBe('consensus');
    expect(result.totalTurns).toBe(4);
  });

  it('returns error when agent fails', async () => {
    const deps = makeDeps([{ result: null, error: 'API timeout' }]);

    const result = await runDualAgent('fix the bug', 'codex', deps);

    expect(result.status).toBe('error');
    expect(result.totalTurns).toBe(1);
  });

  it('stops when user sends !stop', async () => {
    const deps = makeDeps(
      [{ result: 'working on it', error: null }],
      [['!stop']],
    );

    const result = await runDualAgent('fix the bug', 'codex', deps);

    expect(result.status).toBe('stopped');
    expect(deps.sent.some((s) => s.includes('stopped'))).toBe(true);
  });

  it('stops when user sends 중지', async () => {
    const deps = makeDeps(
      [{ result: 'working on it', error: null }],
      [['중지']],
    );

    const result = await runDualAgent('fix the bug', 'codex', deps);

    expect(result.status).toBe('stopped');
  });

  it('reaches max turns and reports', async () => {
    // 10 turns of non-approving responses
    const responses = Array.from({ length: 10 }, (_, i) => ({
      result: `Response ${i + 1}`,
      error: null,
    }));
    const deps = makeDeps(responses);

    const result = await runDualAgent('fix the bug', 'codex', deps);

    expect(result.status).toBe('max_turns');
    expect(result.totalTurns).toBe(10);
    expect(deps.sent.some((s) => s.includes('Max turns reached'))).toBe(true);
  });
});
