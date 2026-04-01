/**
 * NanoClaw Agent Runner (unified: Claude + Codex)
 * Runs as a subprocess on the host, receives config via stdin, outputs result to stdout.
 *
 * Agent type is determined by NANOCLAW_AGENT_TYPE env var ('claude' or 'codex').
 * Both share the same IPC protocol, MCP server, and query loop.
 *
 * Input protocol:
 *   Stdin: Full AgentInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to $NANOCLAW_IPC_DIR/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: $NANOCLAW_IPC_DIR/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 *
 * Environment variables:
 *   NANOCLAW_GROUP_DIR     — path to the group's working directory
 *   NANOCLAW_IPC_DIR       — path to the group's IPC directory
 *   NANOCLAW_GLOBAL_DIR    — path to the global memory directory
 *   NANOCLAW_SESSIONS_DIR  — path to the group's .claude sessions directory
 *   NANOCLAW_AGENT_TYPE    — 'claude' or 'codex' (default: 'claude')
 */

import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface AgentInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isThinking?: boolean;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

// Paths from environment variables (set by the host agent-runner.ts)
const GROUP_DIR = process.env.NANOCLAW_GROUP_DIR!;
const IPC_BASE_DIR = process.env.NANOCLAW_IPC_DIR!;
const GLOBAL_DIR = process.env.NANOCLAW_GLOBAL_DIR || '';
const AGENT_TYPE = process.env.NANOCLAW_AGENT_TYPE || 'claude';
const IPC_INPUT_DIR = path.join(IPC_BASE_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const CODEX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// --- Shared utilities ---

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: AgentOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[${AGENT_TYPE}-runner] ${message}`);
}

// --- IPC ---

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const messages = drainIpcInput();
      if (messages.length > 0) { resolve(messages.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// --- Claude-specific: transcript archival ---

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    return entry?.summary || null;
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();
      const conversationsDir = path.join(GROUP_DIR, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filePath = path.join(conversationsDir, `${date}-${name}.md`);
      fs.writeFileSync(filePath, formatTranscriptMarkdown(messages, summary, assistantName));
      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage { role: 'user' | 'assistant'; content: string; }

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch { /* skip */ }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  });
  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`, '', `Archived: ${formatDateTime(now)}`, '', '---', '');
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

function formatToolUse(name: string, input?: Record<string, unknown>): string {
  if (!input) return `🔧 ${name}`;
  switch (name) {
    case 'Read':
      return `🔧 Read: ${input.file_path || ''}`;
    case 'Write':
      return `🔧 Write: ${input.file_path || ''}`;
    case 'Edit':
      return `🔧 Edit: ${input.file_path || ''}`;
    case 'Bash': {
      const cmd = String(input.command || '');
      return `🔧 Bash: \`${cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd}\``;
    }
    case 'Grep':
      return `🔧 Grep: ${input.pattern || ''} ${input.path ? 'in ' + input.path : ''}`;
    case 'Glob':
      return `🔧 Glob: ${input.pattern || ''}`;
    case 'WebSearch':
      return `🔧 WebSearch: ${input.query || ''}`;
    case 'WebFetch':
      return `🔧 WebFetch: ${input.url || ''}`;
    case 'Agent':
      return `🔧 Agent: ${input.description || input.prompt ? String(input.prompt || '').slice(0, 60) : ''}`;
    default:
      return `🔧 ${name}`;
  }
}

// --- Claude query ---

async function runClaudeQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  agentInput: AgentInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  let globalClaudeMd: string | undefined;
  if (!agentInput.isMain && GLOBAL_DIR) {
    const globalClaudeMdPath = path.join(GLOBAL_DIR, 'CLAUDE.md');
    if (fs.existsSync(globalClaudeMdPath)) {
      globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: GROUP_DIR,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: process.execPath,
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: agentInput.chatJid,
            NANOCLAW_GROUP_FOLDER: agentInput.groupFolder,
            NANOCLAW_IS_MAIN: agentInput.isMain ? '1' : '0',
            NANOCLAW_IPC_DIR: IPC_BASE_DIR,
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(agentInput.assistantName)] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;

      // Stream thinking: extract text and tool_use from assistant message
      const assistantMsg = message as {
        message: {
          content: Array<{
            type: string;
            text?: string;
            name?: string;
            input?: Record<string, unknown>;
          }>;
        };
      };
      const content = assistantMsg.message?.content;
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
          }
        }
        const thinking = texts.join('\n').trim();
        if (thinking) {
          writeOutput({ status: 'success', result: thinking, isThinking: true });
        }
      }
    }
    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }
    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({ status: 'success', result: textResult || null, newSessionId });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

// --- Codex query ---

function parseCodexJsonl(output: string): string | null {
  const messages: string[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
        messages.push(event.item.text);
      }
    } catch { /* skip */ }
  }
  return messages.length > 0 ? messages[messages.length - 1] : null;
}

async function runCodexQuery(
  prompt: string,
): Promise<{ result: string | null; error: string | null; closedDuringQuery: boolean }> {
  return new Promise((resolve) => {
    const codexPath = process.env.CODEX_PATH || 'codex';
    const args = ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--cd', GROUP_DIR];

    log(`Running codex query (${prompt.length} chars) in ${GROUP_DIR}`);

    const proc = spawn(codexPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: GROUP_DIR,
      env: { ...process.env },
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let closedDuringQuery = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log(`Codex timed out after ${CODEX_TIMEOUT_MS / 1000}s, killing`);
        proc.kill('SIGKILL');
        resolve({ result: null, error: 'Codex timed out', closedDuringQuery: false });
      }
    }, CODEX_TIMEOUT_MS);

    // Poll IPC during query
    let ipcPolling = true;
    const pollIpc = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        closedDuringQuery = true;
        ipcPolling = false;
        proc.kill('SIGTERM');
        return;
      }
      drainIpcInput(); // consume but can't pipe into running codex
      setTimeout(pollIpc, IPC_POLL_MS);
    };
    setTimeout(pollIpc, IPC_POLL_MS);

    let lineBuffer = '';
    let lastAgentMessage: string | null = null;

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      lineBuffer += chunk;

      // Process complete JSONL lines as they arrive
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
            // Stream intermediate agent messages as thinking
            writeOutput({ status: 'success', result: event.item.text, isThinking: true });
            lastAgentMessage = event.item.text;
          } else if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
            // Stream tool execution as thinking
            const cmd = event.item.command || '';
            const shortCmd = cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd;
            writeOutput({ status: 'success', result: `🔧 ${shortCmd}`, isThinking: true });
          }
        } catch { /* skip non-JSON */ }
      }
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      log(`[codex] ${chunk.trim().slice(0, 300)}`);
    });

    proc.on('close', (code) => {
      ipcPolling = false;
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (code !== 0 && !closedDuringQuery) {
        resolve({ result: null, error: `Codex exited with code ${code}: ${stderr.slice(-200)}`, closedDuringQuery });
        return;
      }
      log(`Codex finished. stdout: ${stdout.length} chars`);
      // Final result is the last agent message (already streamed as thinking,
      // now emit as the actual result)
      resolve({ result: lastAgentMessage, error: null, closedDuringQuery });
    });

    proc.on('error', (err) => {
      ipcPolling = false;
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      resolve({ result: null, error: `Failed to spawn codex: ${err.message}`, closedDuringQuery: false });
    });
  });
}

// --- Script execution ---

interface ScriptResult { wakeAgent: boolean; data?: unknown; }
const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) log(`Script stderr: ${stderr.slice(0, 500)}`);
      if (error) { log(`Script error: ${error.message}`); return resolve(null); }

      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) { log('Script produced no output'); return resolve(null); }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`Script output missing wakeAgent boolean`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON`);
        resolve(null);
      }
    });
  });
}

// --- Main ---

async function main(): Promise<void> {
  let agentInput: AgentInput;

  try {
    const stdinData = await readStdin();
    agentInput = JSON.parse(stdinData);
    log(`Received input for group: ${agentInput.groupFolder} (agent: ${AGENT_TYPE})`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = agentInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = agentInput.prompt;
  if (agentInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase (scheduled tasks only)
  if (agentInput.script && agentInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(agentInput.script);
    if (!scriptResult || !scriptResult.wakeAgent) {
      log(`Script decided not to wake agent`);
      writeOutput({ status: 'success', result: null });
      return;
    }
    log(`Script wakeAgent=true, enriching prompt`);
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${agentInput.prompt}`;
  }

  // Query loop
  let resumeAt: string | undefined;
  try {
    while (true) {
      if (AGENT_TYPE === 'codex') {
        // --- Codex: single-turn exec ---
        log('Starting codex query...');
        const result = await runCodexQuery(prompt);

        if (result.error) {
          writeOutput({ status: 'error', result: null, error: result.error });
        } else if (result.result) {
          writeOutput({ status: 'success', result: result.result });
        }

        if (result.closedDuringQuery) {
          log('Close sentinel consumed during query, exiting');
          break;
        }
      } else {
        // --- Claude: streaming SDK query ---
        log(`Starting claude query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);
        const result = await runClaudeQuery(prompt, sessionId, mcpServerPath, agentInput, sdkEnv, resumeAt);

        if (result.newSessionId) sessionId = result.newSessionId;
        if (result.lastAssistantUuid) resumeAt = result.lastAssistantUuid;

        if (result.closedDuringQuery) {
          log('Close sentinel consumed during query, exiting');
          break;
        }
      }

      // Emit idle status
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      log('Query ended, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMessage });
    process.exit(1);
  }
}

main();
