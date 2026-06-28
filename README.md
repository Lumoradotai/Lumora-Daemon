# Lumora Daemon

Local agent runtime that connects your machine to the [Lumora](https://github.com/lumora) dashboard for remote AI task execution.

The daemon runs on your computer, polls the Lumora backend for tasks, executes them using locally installed AI agents (Claude Code, OpenClaw, Codex, or the onchainos CLI), and reports results back.

## Architecture

```text
Lumora Dashboard (browser)
       │
       ▼
Lumora Backend (Fastify + Postgres)
       ▲
       │  HTTP poll / claim / heartbeat / submit-result
       │
 ┌─────┴─────┐
 │   Daemon   │  ◄── this repo
 └─────┬─────┘
       │
       ▼
 Local AI Runtimes
   ├── Claude Code
   ├── OpenClaw
   ├── Codex
   └── onchainos CLI
```

The daemon and the dashboard never communicate directly — all coordination flows through the backend via HTTP.

## Installation

```bash
npm install -g lumora-daemon
```

Or run directly with npx:

```bash
npx lumora-daemon --backend-url <URL> --api-key <KEY>
```

## Quick Start

1. Sign in to the Lumora dashboard and add a machine under **Connect Computer**
2. Copy the generated API key (shown only once)
3. Start the daemon:

```bash
lumora-daemon \
  --backend-url https://your-backend.example.com \
  --api-key sk_machine_... \
  --name my-laptop
```

The daemon registers with the backend, reports available runtimes, and begins polling for tasks.

## Supported Agent Types

| Agent | Binary | Purpose |
|-------|--------|---------|
| **OpenClaw** (`claw`) | `openclaw` | General-purpose AI agent |
| **Claude Code** (`claude_code`) | `claude` | Anthropic's coding agent |
| **Codex** (`codex`) | `codex` | OpenAI's coding agent |
| **onchainos CLI** (`cli`) | `onchainos` | Direct CLI execution (no AI, no tokens) for deterministic data commands |

The daemon auto-detects which runtimes are installed and only advertises capabilities for available ones. If no runtimes are found, it starts anyway and waits — you can install runtimes later and the dashboard can trigger onchainos installation remotely.

## Task Lifecycle

1. **User sends a command** via the dashboard
2. **Backend creates a task** (status: `queued`)
3. **Daemon polls** and discovers the task
4. **Daemon claims** the task (status: `claimed`)
5. **Daemon executes** using the appropriate adapter, sending heartbeats during execution
6. **Daemon submits the result** back to the backend (with retry on failure)
7. **Dashboard displays the result** to the user

## Project Structure

```
bin/cli.ts              CLI entrypoint
src/
├── backend-client.ts   HTTP client for the Lumora backend API
├── task-worker.ts      Task polling, claiming, execution, and result submission
├── shared/             Protocol types (Zod schemas)
│   ├── schemas.ts      Task, Command, Result, Heartbeat definitions
│   └── index.ts        Re-exports with inferred TypeScript types
└── core/               Runtime adapters and local utilities
    ├── claw-adapter.ts         OpenClaw adapter
    ├── claude-code-adapter.ts  Claude Code adapter
    ├── codex-adapter.ts        Codex adapter
    ├── cli-adapter.ts          onchainos CLI adapter
    ├── skills.ts               Local skills scanner
    ├── ai-env.ts               AI runtime environment detection
    └── audit.ts                onchainos audit log reader
```

## License

[MIT](LICENSE)
