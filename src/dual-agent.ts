/**
 * Dual-agent orchestrator for NanoClaw.
 * Manages turn-based conversation between Claude and Codex agents
 * with automatic review, feedback, and consensus detection.
 */
import { ChildProcess } from 'child_process';

import { AgentOutput, runAgent } from './agent-runner.js';
import { logger } from './logger.js';
import { AgentType, RegisteredGroup } from './types.js';

const MAX_TURNS_PER_AGENT = 5;

export type LeadAgent = 'claude' | 'codex';

/**
 * Parse user message to determine which agent should lead in dual mode.
 * Returns 'claude' or 'codex' based on @mention, or the default.
 */
export function detectLeadAgent(
  message: string,
  defaultLead: LeadAgent = 'codex',
): LeadAgent {
  const lower = message.toLowerCase();
  if (/@claude\b/.test(lower)) return 'claude';
  if (/@codex\b/.test(lower)) return 'codex';
  return defaultLead;
}

/**
 * Strip @claude / @codex mentions from the message content.
 */
export function stripAgentMentions(message: string): string {
  return message.replace(/@(claude|codex)\b/gi, '').trim();
}

function otherAgent(agent: LeadAgent): LeadAgent {
  return agent === 'claude' ? 'codex' : 'claude';
}

function agentLabel(agent: LeadAgent): string {
  return agent === 'claude' ? 'Claude' : 'Codex';
}

function agentPrefix(agent: LeadAgent): string {
  return agent === 'claude' ? '🟣 **Claude:**' : '🟢 **Codex:**';
}

function makeReviewPrompt(
  originalMessage: string,
  leadName: string,
  leadResponse: string,
): string {
  return (
    `[Dual Agent Review Request]\n` +
    `User's original request: ${originalMessage}\n` +
    `${leadName}'s work:\n${leadResponse}\n\n` +
    `You are the reviewer. Do NOT trust the lead agent's claims at face value.\n` +
    `Use your tools (Read, Grep, Bash, etc.) to independently verify the work.\n\n` +
    `Review on two dimensions:\n\n` +
    `1. **Spec Compliance**: Does the result correctly address the user's request? ` +
    `Open the relevant files yourself and verify the claims are accurate.\n` +
    `2. **Quality**: Is the approach sound? Check for edge cases, missing items, or better alternatives.\n\n` +
    `For each dimension:\n` +
    `- Name the files you opened or commands you ran to verify.\n` +
    `- State what you found.\n\n` +
    `If both dimensions pass after your independent check, end with [DONE].\n` +
    `If you find issues, provide specific feedback without [DONE].`
  );
}

function makeFeedbackPrompt(
  reviewerName: string,
  reviewerResponse: string,
): string {
  return (
    `[Dual Agent Feedback]\n` +
    `${reviewerName}'s feedback:\n${reviewerResponse}\n\n` +
    `Address the feedback above. For each point raised, explain what you changed or why you disagree.\n` +
    `If you believe all issues are resolved, end with [DONE].`
  );
}

function makeUserInterjectionPrompt(userMessage: string): string {
  return (
    `[User Follow-up]\n` +
    `${userMessage}\n\n` +
    `Incorporate the user's request above into your current work and continue.`
  );
}

function isDone(response: string): boolean {
  return /\[DONE\]/i.test(response) || /\[APPROVED\]/i.test(response);
}

export interface DualAgentDeps {
  /** Run a single agent and return its text response. */
  runSingleAgent: (
    agentType: 'claude' | 'codex',
    prompt: string,
    chatJid: string,
    groupFolder: string,
    isMain: boolean,
    assistantName: string,
    sessionId?: string,
    onProcess?: (proc: ChildProcess, processName: string) => void,
  ) => Promise<{ result: string | null; error: string | null }>;

  /** Send a message to the Discord channel. agentType routes to the correct bot. */
  sendMessage: (text: string, agentType?: 'claude' | 'codex') => Promise<void>;

  /** Check for new user messages (non-blocking). */
  drainUserMessages: () => string[];

  /** Discord user ID of the requesting user, for @mentions. */
  userDiscordId?: string;
}

export interface DualAgentResult {
  status: 'consensus' | 'max_turns' | 'stopped' | 'error';
  totalTurns: number;
}

/**
 * Run a dual-agent conversation.
 *
 * Flow:
 * 1. Lead agent processes the original request
 * 2. Reviewer agent reviews the lead's response
 * 3. If reviewer approves → done
 * 4. If reviewer has feedback → lead processes feedback
 * 5. Repeat until consensus or max turns
 */
export async function runDualAgent(
  originalMessage: string,
  lead: LeadAgent,
  deps: DualAgentDeps,
): Promise<DualAgentResult> {
  const reviewer = otherAgent(lead);
  const mention = deps.userDiscordId ? `<@${deps.userDiscordId}>` : '';
  let totalTurns = 0;
  let currentAgent: LeadAgent = lead;
  let prompt = originalMessage;
  let lastResponse = '';

  for (let turn = 0; turn < MAX_TURNS_PER_AGENT * 2; turn++) {
    // Check for user messages that arrived during the previous turn
    const userMessages = deps.drainUserMessages();
    for (const msg of userMessages) {
      const lower = msg.trim().toLowerCase();
      if (lower === '!stop' || lower === '중지') {
        await deps.sendMessage(
          mention
            ? `${mention} Dual agent conversation stopped.`
            : `Dual agent conversation stopped.`,
        );
        return { status: 'stopped', totalTurns };
      }
      // Append user follow-up to the end of the prompt (after review context)
      prompt = prompt + '\n\n' + makeUserInterjectionPrompt(msg);
    }

    logger.info(
      {
        turn: turn + 1,
        agent: currentAgent,
        role:
          turn === 0
            ? 'lead'
            : currentAgent === lead
              ? 'lead-response'
              : 'reviewer',
      },
      'Dual agent turn',
    );

    const { result, error } = await deps.runSingleAgent(
      currentAgent,
      prompt,
      '', // chatJid handled by caller
      '', // groupFolder handled by caller
      false,
      agentLabel(currentAgent),
    );

    totalTurns++;

    if (error || !result) {
      logger.error({ agent: currentAgent, error }, 'Dual agent turn failed');
      await deps.sendMessage(
        mention
          ? `${mention} ${agentLabel(currentAgent)} agent error: ${error || 'no response'}`
          : `${agentLabel(currentAgent)} agent error: ${error || 'no response'}`,
        currentAgent,
      );
      return { status: 'error', totalTurns };
    }

    lastResponse = result;

    // Send the agent's response via the corresponding bot (strip [DONE]/[APPROVED] tokens)
    const cleanResult = result
      .replace(/\[DONE\]/gi, '')
      .replace(/\[APPROVED\]/gi, '')
      .trim();
    if (cleanResult) {
      await deps.sendMessage(cleanResult, currentAgent);
    }

    // Check for done/consensus
    if (isDone(result)) {
      if (currentAgent === reviewer || turn === 0) {
        // Reviewer approved the lead's work, or lead approved reviewer's feedback
        await deps.sendMessage(
          mention
            ? `${mention} Both agents reached consensus. ✅`
            : `Both agents reached consensus. ✅`,
        );
        return { status: 'consensus', totalTurns };
      }
      // Lead approved reviewer's feedback — still need reviewer to confirm
    }

    // Prepare next turn
    if (currentAgent === lead && turn === 0) {
      // First turn done: send to reviewer for review
      prompt = makeReviewPrompt(
        originalMessage,
        agentLabel(lead),
        lastResponse,
      );
      currentAgent = reviewer;
    } else if (currentAgent === reviewer) {
      if (isDone(result)) {
        await deps.sendMessage(
          mention
            ? `${mention} Both agents reached consensus. ✅`
            : `Both agents reached consensus. ✅`,
        );
        return { status: 'consensus', totalTurns };
      }
      // Reviewer gave feedback: send back to lead
      prompt = makeFeedbackPrompt(agentLabel(reviewer), lastResponse);
      currentAgent = lead;
    } else {
      // Lead responded to feedback: send to reviewer again
      prompt = makeReviewPrompt(
        originalMessage,
        agentLabel(lead),
        lastResponse,
      );
      currentAgent = reviewer;
    }
  }

  await deps.sendMessage(
    mention
      ? `${mention} Max turns reached (${totalTurns} turns) — your input is needed.`
      : `Max turns reached (${totalTurns} turns) — user input needed.`,
  );
  return { status: 'max_turns', totalTurns };
}

/**
 * Create a RegisteredGroup override for running a specific agent type.
 * Used by the dual orchestrator to run Claude or Codex independently.
 */
export function makeAgentGroup(
  baseGroup: RegisteredGroup,
  agentType: 'claude' | 'codex',
): RegisteredGroup {
  return { ...baseGroup, agentType };
}
