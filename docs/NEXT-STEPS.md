# Next steps

Where the build stands against [DESIGN.md](../DESIGN.md) › Build sequence and acceptance.

## Done during setup

- [x] **Official Windows CLI works.** The `Unsupported platform: win32 (x64)` error came from an old global install, `@openai/codex` 0.3.0, which shipped no Windows build. The project now pins `@openai/codex` 0.167.0 in `package.json`. It runs on this PC from `node_modules`.
- [x] **App Server starts and handshakes.** `codex app-server` starts over stdio and completes `initialize` with the experimental API enabled.
- [x] **Protocol types generated** from the pinned version, including the experimental dynamic tool interface (`dynamicTools` on `thread/start`, `item/tool/call` requests).
- [x] **AiHub has its own `CODEX_HOME`** in `.codex-home/`, so it never loads your personal Codex config or MCP servers.
- [x] **Daemon and UI skeletons.** The daemon serves `/api/health` on loopback and rejects foreign `Host` headers with 421. The UI shows the daemon's status.

## Step 1: sign in and run the spike (you)

```bash
npm run codex -- login
```

```bash
npm run spike:codex
```

The spike streams a reply, calls an AiHub tool, probes isolation with a canary file, and measures usage. [spikes/codex-app-server/README.md](../spikes/codex-app-server/README.md) explains each check and what to try if one fails.

## Step 2: decide whether Codex fits (gate)

| Spike result | Decision |
| --- | --- |
| All checks pass | Continue with Codex as the runtime for all runs. |
| Streaming and tool calls pass, isolation fails | Use Codex for the Chief of Staff chat only. Plan a different runtime for data-reading runs, behind the same runtime interface. |
| Tool calls fail | The experimental interface is not usable in this version. Revisit the runtime choice before building further. |

Record the result and the measured usage in this file.

## Step 3: the rest of Milestone 1

Each item maps to the Milestone 1 acceptance in DESIGN.md.

1. **Runtime interface.** Move the spike's JSON-RPC client into `apps/daemon/src/runtime/` behind a small interface: start a context, run a turn with assembled context and allowed tools, stream events, handle tool calls, and report usage. Write contract tests against the interface.
2. **SQLite, schema v0.** Use the built-in `node:sqlite`. Add tables for agents, chat messages, runs, and the Chief of Staff thread ID.
3. **Chief of Staff chat.** Add `POST /api/chat` and a server-sent events stream at `/api/events`. On reconnect, the UI loads current state before following the stream.
4. **Restore after restart.** Resume the saved thread with `thread/resume`. If that fails, start a new thread from records and recent chat history.
5. **Loopback hardening, second part.** Add the `Origin` check and the per-install token cookie.
6. **Usage measurement.** Run a simulated four-section briefing and record turns, tokens, and the change in your usage limit.
7. **Control surface.** Build the roster, activity feed, and chat, all reflecting real run state. The 2D office comes in Milestone 3.
