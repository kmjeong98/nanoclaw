# NanoClaw

Discord-only dual-agent orchestrator powered by Claude Code and Codex CLI. Forked from [NanoClaw](https://github.com/qwibitai/nanoclaw).

Agents run as direct host subprocesses (no containers). Each Discord channel gets isolated filesystem and memory.

## Prerequisites

- Linux (Ubuntu recommended) or macOS
- Node.js 20+
- [Claude Code](https://claude.ai/download) CLI installed and logged in (`claude login`)
- A Discord bot token

## Installation

```bash
git clone https://github.com/<your-username>/nanoclaw.git
cd nanoclaw
npm install
cd agent && npm install && cd ..
npm run build
```

## Configuration

### 1. Claude Code authentication

Log in to Claude Code on the host machine:

```bash
claude login
```

NanoClaw automatically symlinks your `~/.claude/.credentials.json` into each agent's session directory, so agents authenticate using your existing login.

Alternatively, set `ANTHROPIC_API_KEY` in `.env` if you prefer API key auth.

### 2. Discord bot setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) and create a new application
2. Go to **Bot** tab, click **Reset Token**, and copy the token
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Go to **OAuth2** > **URL Generator**, select `bot` scope with permissions:
   - Send Messages
   - Read Message History
   - Use Slash Commands
5. Open the generated URL to invite the bot to your server

### 3. Environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required: Discord bot token
DISCORD_BOT_TOKEN=your-discord-bot-token

# Optional: Anthropic API key (if not using `claude login`)
ANTHROPIC_API_KEY=sk-ant-...

# Optional: OpenAI API key (for Codex CLI agent)
OPENAI_API_KEY=sk-...

# Optional: Assistant name / trigger word (default: Andy)
ASSISTANT_NAME=Andy

# Optional: Timezone (default: auto-detected)
TZ=Asia/Seoul
```

## Running

### Development (foreground)

```bash
npm run dev
```

### Production (systemd)

```bash
bash scripts/setup-service.sh
systemctl --user start nanoclaw
loginctl enable-linger $(whoami)
```

Manage:

```bash
systemctl --user status nanoclaw     # Check status
systemctl --user restart nanoclaw    # Restart
journalctl --user -u nanoclaw -f     # View logs
```

## Usage

Send messages in your registered Discord channel. The trigger word (default: `@Andy`) activates the agent:

```
@Andy summarize the last 10 commits
@Andy send me a sales report every weekday at 9am
@Andy review this PR and post feedback
```

If the channel has `requiresTrigger: false`, the agent responds to all messages.

From the main channel, you can manage groups and tasks:

```
@Andy list all scheduled tasks
@Andy pause the morning report task
```

## Architecture

```
Discord --> SQLite --> Polling loop --> Agent subprocess (Claude Code SDK) --> Response
```

- **Host process** (`src/`): Connects to Discord, polls for messages, manages groups and queues
- **Agent subprocess** (`agent/`): Spawned per-group, runs Claude Agent SDK, communicates via stdin/stdout markers and IPC files
- **IPC**: File-based JSON in `data/ipc/{group}/` for messages, tasks, and group registration
- **No containers**: Agents run directly on the host as Node.js subprocesses

Key files:

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/agent-runner.ts` | Spawns agent subprocesses |
| `src/channels/discord.ts` | Discord channel adapter |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/db.ts` | SQLite operations |
| `src/group-queue.ts` | Per-group queue with concurrency control |
| `src/task-scheduler.ts` | Scheduled task execution |
| `agent/src/index.ts` | Agent subprocess (Claude Agent SDK query loop) |
| `agent/src/ipc-mcp-stdio.ts` | MCP server for agent IPC tools |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## License

MIT
