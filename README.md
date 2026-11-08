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
| `npm run windows -- install` | Runs AiHub in the background on Windows: now and at every sign-in, with no window, an icon in the notification area, a Start menu entry, and notifications (`AIHUB_NOTIFICATIONS=off` turns them off). Its log is `data/logs/daemon.log`. `uninstall` removes it all, and `status` says what's installed. |
| `npm run probe:failures` | Shows how AiHub reads a signed-out and an offline Codex, and the plan's usage, without touching the real sign-in. Spends no usage. |

## The morning briefing

Ask the Chief of Staff in chat to look after something, such as your work calendar. She proposes a supervisor on a card in the chat; approve it and pick the `.ics` export it should read. On weekdays at 07:00 Stockholm time the supervisors check their sources and the Chief of Staff posts one briefing in her chat. Items land in the Inbox, where you resolve or dismiss them. An hour earlier a health check posts a notice if Codex is signed out, a source can't be read, or usage is nearly spent. Run now on the Chief of Staff's profile card briefs you on request. The daemon has to be running at 07:00; a briefing it missed runs when it starts later that day.

### Web search

Some staff look things up instead of reading a file, such as a supervisor who summarizes the news. Give a staff member web search on their profile card, optionally limited to some sites, or approve it on the Chief of Staff's proposal card. It is Codex's cached web search: it answers from OpenAI's search index and opens no live pages, so no site sees what your staff look up. What it finds is treated like source data, and every search shows in the activity log.

A supervisor with web search and no source researches what is new since the last briefing and gives each story's address. The same story isn't new twice, and stories drop off after two days instead of staying in the Inbox. Live browsing stays off; DESIGN.md › Authority and data boundaries says why.

## In the background

`npm run windows -- install` keeps AiHub running without a window: it starts now and at every Windows sign-in.

AiHub's icon in the notification area opens the office with a click. Its menu says when the next briefing is and what needs you, such as items in your inbox or a proposal to approve, and a dot on the icon marks what can't wait. The menu also opens the staff notes and quits AiHub. Windows 11 puts a new icon under the ^ arrow at first; drag it onto the taskbar to keep it in sight. The Start menu entry opens the office too, and starts AiHub first if you quit it.

Before each health check it sets a Task Scheduler task that wakes the PC from sleep, and it keeps the PC awake until the briefing is done. Wake timers have to be allowed in the power plan; `npm run windows -- status` says whether they are, along with what is installed. Windows notifications tell you when the briefing is ready, with counts but none of its content, and when something needs you first. Clicking one opens the office.

If Codex is signed out, offline, busy, or out of usage, the briefing waits instead of failing. The chat and a notification say why and when it tries again, and it keeps trying until the end of the day. Anything it didn't report shows up in the next briefing.

`npm run windows -- uninstall` stops AiHub and removes the tasks, the Start menu entry, and the notification registration. Your office's data stays in `data/`.

`npm run dev:fake` opens a furnished sample office with the same flow, reading `apps/daemon/test/fixtures/work.ics`.

## Teams and delegation

The Chief of Staff can ask a supervisor a question or hand one a task. Her turn ends there, the supervisor works in a run of its own, and she brings you the answer in a new message in the same chat. A supervisor working on a task can ask a colleague, or recruit a worker for one bounded part and share some of its own sources with it. The supervisor accepts the worker's result or sends it back once with feedback, and then the worker leaves the office with its access revoked. Its notes stay. The Assignments button in the top bar shows who works on what, nested by task.

Caps keep this bounded: 3 open questions per staff member, 4 open tasks, 2 workers per supervisor, a run budget per task, and the daily turn limit. A run that answers a question or follows up results can't delegate again, so nothing loops.

In the fake office, try "ask Oskar whether …" or "give Elin a task with a helper: …" in the Chief of Staff's chat.

## Folders and readers

A supervisor can watch a folder on this PC as well as a calendar export. Tell the Chief of Staff what the files are, such as "my reading list is a folder of markdown notes", and the card proposes a supervisor with a reader for them. Pick the folder, press Preview to see what AiHub reads there, and approve. Built-in readers cover markdown notes (frontmatter becomes fields), plain text, CSV, and JSON. AiHub reads only the matching files in that folder, up to 2,000 files of 2 MB each.

For a format none of them fits, such as a bank statement with its own layout, paste or describe a sample in chat. The Chief of Staff brings in a toolsmith, who writes a reader from the sample, never from your files, tests it, and leaves. The card for the supervisor who will use it shows the reader's code and notes, and Approve waits until you have previewed your real folder with it. Approving pins that exact code: a reader written by staff runs only as approved, in a sealed WebAssembly sandbox with no access to files, the network, or the rest of the PC.

Chat with any staff member from their profile card. A supervisor answers from its own sources and notes, and can't read another supervisor's.

In the fake office, try "watch my reading list" or "write a reader for my bank export" in the Chief of Staff's chat.

## Staff notes

Staff keep their notes in a vault of markdown files at `data/vault/`, one folder per staff member under `Staff/` plus a shared `Office/` folder. Open the folder in Obsidian to browse the notes and their graph, or point `AIHUB_VAULT_DIR` at a folder inside an existing vault. AiHub picks up notes you edit there. Profile notes follow each staff card, so edit profiles in AiHub instead.
