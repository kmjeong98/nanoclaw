# NanoClaw

Discord-only dual-agent orchestrator (Claude Code + Codex CLI). Forked from NanoClaw.

## Quick Context

Single Node.js process with Discord as the only channel. Each channel has an `agentType`:
- `claude` — Claude Code only (via Agent SDK)
- `codex` — Codex CLI only (via `codex exec --json --full-auto`)
- `dual` — Both agents collaborate: lead responds, reviewer reviews, iterate until `[APPROVED]`

Agents run as direct subprocesses on the host (no containers). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/agent-runner.ts` | Spawns agent subprocesses with IPC |
| `src/channels/registry.ts` | Channel registry (Discord only) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/db.ts` | SQLite operations |
| `src/group-queue.ts` | Group-level queue, concurrency control |
| `src/dual-agent.ts` | Dual-agent orchestrator (turn mgmt, consensus) |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `agent/src/index.ts` | Agent subprocess (Claude Agent SDK query loop) |
| `agent/src/codex-runner.ts` | Codex CLI agent subprocess |
| `agent/src/ipc-mcp-stdio.ts` | MCP server for agent IPC (send_message, schedule_task, etc.) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Credentials

API keys managed via `.env` file (see `.env.example`):
- `ANTHROPIC_API_KEY` — for Claude Code agent
- `DISCORD_BOT_TOKEN` — for Discord bot
- `OPENAI_API_KEY` — for Codex CLI agent (optional)

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run build          # Compile TypeScript (host + agent)
npm run build:host     # Compile host only
npm run build:agent    # Compile agent only
npm run dev            # Run with hot reload
npm test               # Run tests
```

Service management (Linux/systemd):
```bash
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Architecture

- **Host process** (`src/`): Connects to Discord, polls for messages, manages groups/queues
- **Agent subprocess** (`agent/`): Spawned per-group, runs Claude Agent SDK, communicates via stdin/stdout markers and IPC files
- **IPC**: File-based (JSON files in `data/ipc/{group}/`), supports messages, tasks, group registration
- **No containers**: Agents run directly on the host as Node.js subprocesses
