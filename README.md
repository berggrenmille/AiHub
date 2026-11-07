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
| `npm run measure:briefing` | Runs a simulated four-section briefing against real Codex and reports its turns, tokens, and isolation checks. Uses about 100K input tokens. |
| `npm run codex -- <args>` | Runs the pinned Codex CLI with AiHub's `CODEX_HOME`. |
| `npm run codex:protocol` | Regenerates the App Server protocol types after a Codex upgrade. |

## The morning briefing

Ask the Chief of Staff in chat to look after something, such as your work calendar. She proposes a supervisor on a card in the chat; approve it and pick the `.ics` export it should read. On weekdays at 07:00 Stockholm time the supervisors check their sources and the Chief of Staff posts one briefing in her chat. Items land in the Inbox, where you resolve or dismiss them. An hour earlier a health check posts a notice if Codex is signed out, a source can't be read, or usage is nearly spent. Run now on the Chief of Staff's profile card briefs you on request. The daemon has to be running at 07:00; a briefing it missed runs when it starts later that day.

`npm run dev:fake` opens a furnished sample office with the same flow, reading `apps/daemon/test/fixtures/work.ics`.

## Staff notes

Staff keep their notes in a vault of markdown files at `data/vault/`, one folder per staff member under `Staff/` plus a shared `Office/` folder. Open the folder in Obsidian to browse the notes and their graph, or point `AIHUB_VAULT_DIR` at a folder inside an existing vault. AiHub picks up notes you edit there. Profile notes follow each staff card, so edit profiles in AiHub instead.
