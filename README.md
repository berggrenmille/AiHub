# AiHub

A local, game-like office for your personal staff of AI agents. The Chief of Staff turns your goals into standing responsibilities, recruits supervisors, and brings you one briefing on weekday mornings. See [DESIGN.md](DESIGN.md) for the full design and [docs/NEXT-STEPS.md](docs/NEXT-STEPS.md) for where the build stands.

## Layout

| Path | What it is |
| --- | --- |
| `apps/daemon` | Fastify daemon on `127.0.0.1:7420`. Owns state, scheduling, and the Codex runtime. |
| `apps/web` | React and Vite UI. In development, Vite proxies `/api` to the daemon. |
| `packages/shared` | Types shared by the daemon and the UI. |
| `packages/codex-protocol` | Codex App Server protocol types, generated from the pinned Codex version. |
| `spikes/codex-app-server` | Milestone 1 spike that drives Codex App Server and probes run isolation. |
| `scripts/codex.mjs` | Runs the project's pinned Codex CLI with AiHub's own `CODEX_HOME`. |

## Setup

Requires Node.js 22.13 or later.

```bash
npm install
```

Codex is pinned in `package.json` and runs from `node_modules`, not from a global install. AiHub keeps its Codex sign-in, config, and sessions in `.codex-home/` (ignored by git), separate from your personal `~/.codex`. Sign in once:

```bash
npm run codex -- login
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the daemon and the UI at http://127.0.0.1:5173. |
| `npm run dev:fake` | Same, with a fake runtime instead of Codex: no sign-in, no usage, and its own state in `data/fake/`. |
| `npm run typecheck` | Typechecks every workspace and the spike. |
| `npm test` | Runs the tests. They use a fake Codex App Server, so they need no sign-in. |
| `npm run build` | Builds the UI. |
| `npm run spike:codex` | Runs the Codex App Server spike. |
| `npm run codex -- <args>` | Runs the pinned Codex CLI with AiHub's `CODEX_HOME`. |
| `npm run codex:protocol` | Regenerates the App Server protocol types after a Codex upgrade. |
