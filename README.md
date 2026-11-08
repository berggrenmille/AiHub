# AiHub

A local, game-like office for your personal staff of AI agents. The Chief of Staff turns your goals into standing responsibilities, recruits supervisors, and brings you one briefing on weekday mornings. See [DESIGN.md](DESIGN.md) for the full design and [docs/NEXT-STEPS.md](docs/NEXT-STEPS.md) for where the build stands.

## Layout

| Path | What it is |
| --- | --- |
| `apps/daemon` | Fastify daemon on `127.0.0.1:7420`. Owns state, scheduling, and the Codex runtime. |
| `apps/web` | React and Vite UI. In development, Vite proxies `/api` to the daemon. |
| `packages/shared` | Types shared by the daemon and the UI. |
| `packages/views` | The components views may use, defined once for the daemon's check and the UI's renderers, and the guide staff read. |
| `packages/codex-protocol` | Codex App Server protocol types, generated from the pinned Codex version. |
| `spikes/codex-app-server` | Milestone 1 spike that drives Codex App Server and probes run isolation. |
| `spikes/connectors` | Milestone 6 probe of ChatGPT apps and MCP servers through Codex App Server. |
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
| `npm run spike:connectors` | Runs the Milestone 6 connector probe: a made-up mail service over MCP with its own sign-in, and a list of the ChatGPT apps on AiHub's sign-in. It runs no model turn. |
| `npm run measure:briefing` | Runs a simulated four-section briefing against real Codex and reports its turns, tokens, and isolation checks. Uses about 100K input tokens. |
| `npm run codex -- <args>` | Runs the pinned Codex CLI with AiHub's `CODEX_HOME`. |
| `npm run codex:protocol` | Regenerates the App Server protocol types after a Codex upgrade. |
| `npm run windows -- install` | Runs AiHub in the background on Windows: now and at every sign-in, with no window, an icon in the notification area, a Start menu entry, and notifications (`AIHUB_NOTIFICATIONS=off` turns them off). Its log is `data/logs/daemon.log`. `uninstall` removes it all, and `status` says what's installed. |
| `npm run probe:failures` | Shows how AiHub reads a signed-out and an offline Codex, and the plan's usage, without touching the real sign-in. Spends no usage. |

## The morning briefing

Ask the Chief of Staff in chat to look after something, such as your work calendar. She proposes a supervisor on a card in the chat; approve it and pick the `.ics` export it should read. On weekdays at 07:00 Stockholm time the supervisors check their sources and the Chief of Staff posts one briefing in her chat. To have it on weekends too, tick Weekends too under the briefing on the Chief of Staff's profile card. Findings that need you to do or decide something, such as a meeting clash, land in the Inbox, where you resolve or dismiss them, saying how or why if you like. What is only worth knowing, such as a moved meeting, is in the briefing and doesn't wait in the Inbox. An hour earlier a health check posts a notice if Codex is signed out, a source can't be read, or usage is nearly spent. Run now on the Chief of Staff's profile card briefs you on request. The daemon has to be running at 07:00; a briefing it missed runs when it starts later that day.

### Web search

Some staff look things up instead of reading a file, such as a supervisor who summarizes the news. Give a staff member web search on their profile card, optionally limited to some sites, or approve it on the Chief of Staff's proposal card. It is Codex's cached web search: it answers from OpenAI's search index and opens no live pages, so no site sees what your staff look up. What it finds is treated like source data, and every search shows in the activity log.

A supervisor with web search and no source researches what is new since the last briefing and gives each story's address. The same story isn't new twice. Stories are only for reading, so they never go in the Inbox, and dashboards can list them for two days. Live search, which opens pages on the sites themselves, is an unsafe grant: tick Live search on the profile card or the proposal card to allow it (below, Accounts and services).

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

## Accounts and services

Staff can read outside accounts, such as your mail, through services. A service is a ChatGPT app connected to your ChatGPT account, or an MCP server at an address or running on this PC. Ask the Chief of Staff in chat, such as "watch my inbox". If no service fits, she proposes one on a card. Approve it, then sign in from the card, or for an app, connect it at ChatGPT from the card's link. AiHub never sees your password: Codex keeps the sign-in.

Then she proposes a supervisor whose source is a read operation on the service, such as listing the latest mail. Preview reads the account now, so you see what the supervisor would get, and Approve waits for it. At each briefing AiHub reads the account in code and hands the supervisor only what is new, and each item opens where it came from. The card also lists the operations the supervisor may call itself in chat and tasks, such as searching the mailbox.

Some grants break the data boundary (DESIGN.md › Authority and data boundaries): an operation that changes or sends something, one that may reach others, live web search, and a program that runs on this PC. Each has its own tick on the card, with a sentence on what could go wrong, and approving never covers one you didn't tick. Every use shows in the activity log, marked Unsafe. To give a supervisor more later, such as sending replies, ask the Chief of Staff, and the card works the same way.

The Access button in the top bar lists everything staff can reach. Unsafe grants come first, then services and who may call what, sources and who reads them, readers, web search, and each staff member's AiHub tools. Revoke or remove anything there; it takes effect at the next call. When a sign-in lapses, AiHub says so in the Chief of Staff's chat and in Access, and the health check before the briefing says it again.

In the fake office, try "watch my inbox" in the Chief of Staff's chat, then "let Ines send replies" with the name she proposed. The fake mail service holds made-up messages, one of them a prompt injection, and its sign-in finishes by itself after a few seconds; the page it opens doesn't exist.

## Staff notes

Staff keep their notes in a vault of markdown files at `data/vault/`, one folder per staff member under `Staff/` plus a shared `Office/` folder. Open the folder in Obsidian to browse the notes and their graph, or point `AIHUB_VAULT_DIR` at a folder inside an existing vault. AiHub picks up notes you edit there. Profile notes follow each staff card, so edit profiles in AiHub instead.

## Models and reasoning

Each staff member's profile card shows the model and reasoning level they run on, and what their last run used; each recent run lists it too, as does the run's line in the activity log. Change them with Change on the card: the lists are the models your Codex sign-in offers and the levels each supports. Staff you haven't set run on the office default, the model Codex marks as its default at that model's default reasoning. When the Chief of Staff proposes a supervisor, she picks a model and level that fit the work and says why on the card. More reasoning thinks longer and uses more of your plan on every run.

## Views and dashboards

Staff can answer with a chart, a table, a few key numbers, a list, or a timeline where it reads better than text. Ask for one in chat, such as "show me this month's spending as a chart"; it appears under the reply. A supervisor can add one to its section of the morning briefing, though most sections need none. Hover a chart to read its values, use the arrow keys to step through them, or switch it to a table.

Ask the Chief of Staff or a supervisor for a dashboard in chat, such as "make me a dashboard of open items by staff member", and it appears in the Dashboards tab. A dashboard reads the office's records each time it opens, so its numbers are current, and Refresh reads them again. Opening one never changes anything. Ask opens a chat with whoever made it, ready for your question, and Remove deletes it.

A button in a view says what it does: hover it to read its action, and one that opens a page shows the site. A message for staff goes into the chat box for you to edit or send. In chat and on dashboards, a picture from another site waits for your click on a placeholder that names the site, so an address can't carry anything out of the office by itself.

In the fake office, try "show me a chart" or "make me a dashboard" in the Chief of Staff's chat.

## Staff review

The Chief of Staff looks over the supervisors when AiHub notices a warning sign after a briefing: a section missing from two briefings in a row, a source that couldn't be read for three, most of a supervisor's findings dismissed, or nothing found in two weeks. A sign that still stands a week later gets one more look. A week without a new sign costs nothing, and Review now on her profile card asks for a review at any time.

She reads only counts and your decisions, such as runs, failures, usage, how many findings you resolved or dismissed, and the reasons you gave for dismissing, never what supervisors reported. When something would serve you better, she writes a short staff review in her chat, followed by a card for each change: new scope or standing instructions, another model or reasoning level, ending a responsibility so its supervisor leaves, or a replacement who takes over the work with empty notes. She can also propose a new supervisor. Nothing changes until you approve, and she can propose the same changes in chat when you ask, as well as more operations for a supervisor on a service. With nothing to suggest she posts nothing and notes why in her journal.

In the fake office, press Review now on Vera's card.

## Office policy

The Policy button in the top bar holds the rules every staff member works under, such as the language to write in, what always counts as urgent, or what never goes in notes. They go into each staff member's instructions from their next run. Write them yourself in the panel, or tell the Chief of Staff in chat; she proposes the whole new policy on a card that shows what changes, and nothing applies until you approve it. The badge on the button shows a proposal is waiting. Earlier versions stay listed in the panel. The policy can't give anyone access they don't have.
