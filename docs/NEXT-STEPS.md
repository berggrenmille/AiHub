# Next steps

Where the build stands against [DESIGN.md](../DESIGN.md) › Build sequence and acceptance.

## Up next

After the Milestone 6 proof the operator asked for meetings, a bigger chat, a calmer screen, room for 16 supervisors, fewer unsafe ticks, and a better way to read the briefing. The plan they accepted on 2026-11-08, built in this order:

1. **Layout and notifications.** Done, below.
2. **Meetings.** The Chief of Staff chairs, and AiHub runs rounds: each supervisor speaks in turn, and one with nothing new passes without a turn. A meeting ends with a card of decisions and assignments that the operator approves. The operator calls one, the Chief of Staff calls one, or a standup routine does. Meetings only talk: no operation runs in one. A meeting room on the floor.
3. **A Today page in place of the Inbox.** What needs the operator first, then the briefing by supervisor, each section with Open source and Discuss. The chat gets one line that links to it, and nothing asks a question before the briefing.
4. **16 supervisors.** A floor of four by four that scales to fit, and the day's turn budget as a setting with a higher default.

At any point along the way:
- Unsafe ticks grouped by service and kind: one tick for a service's operations that add or change, another for those that delete or overwrite, read from the operations' own labels. A destructive operation never shares a tick with one that isn't. This changes DESIGN.md's "its own tick" rule.
- The daemon checks a call's arguments against the operation's input schema before calling the service.

The proof used a ChatGPT app, so what the probe left open about MCP servers is still open: Windows Credential Manager as the store for sign-ins, a real MCP server's sign-in, and how long its refresh token lasts.

## Layout and notifications (2026-11-08)

The operator found the top bar bloated, toasts piling up over the chat, and the chat too small, and asked whether several threads with one person would help. The answer they took: named topics, each in a thread of its own, and no forking of a chat. DESIGN.md › Office experience › Layout and notifications has the rules as built.

1. **A rail and a slim top bar.** `Rail.tsx` holds the pages, the Assignments panel, Access, Policy, and settings with the theme, each with its count, and shows icons alone below 1,280 px. `TopBar.tsx` keeps the office's numbers on the office page, energy, one health chip (Codex, the page's connection, and the sources, listed on click), the time, and the chat button. `Hud.tsx` is gone.
2. **Toasts for what needs the operator.** `lib/toasts.ts` decides: a failed or blocked run, a proposal, a proposed policy or service, a health problem, and the briefing. A card doesn't toast while its chat is on screen. Toasts sit under the top bar, step left of an open chat, and show two at a time; a burst folds into a line that opens the activity log.
3. **Chats full screen, with topics.** The Chats page lists each staff member's general chat and topics with unread counts, and opens one at reading width. The drawer switches between them and expands to the page. A topic is a conversation with its own model thread (migration v16, `POST /api/agents/:id/topics`, `PATCH /api/conversations/:id`), named by the operator's first message and renamed from its title. A card from a chat turn of the Chief of Staff's stays in that chat, and the notice when it is decided goes beside it.

### How it was shown

- Tests: `office.test.ts` ("starts a topic in a thread of its own, named by the operator's first message" and "puts a card where the operator asked for it, and the answer to the card beside it"), `server.test.ts` ("starts and renames a topic"), `lib/chat.test.ts`, and `lib/toasts.test.ts`.
- In a browser against the fake office at 1,440 and 1,024 px wide, in both themes: the rail collapsing to icons with nothing wider than the window, the health and settings popovers, the Chats page with a long topic name, a new topic named by its first message, renaming it, and the drawer's topic switch and expand button.

### Known gaps

- A topic can't be closed or removed; the list grows with them.
- Unread counts live in the browser, so another browser counts everything before its first visit as read.

## Milestone 6 proof against real GitHub (2026-11-08)

GitHub is connected at ChatGPT with two linked accounts, Personal and Work. Everything went through the installed office at 127.0.0.1:7420, from the Chief of Staff's chat.

| Check | What happened |
| --- | --- |
| Set up from chat | Asked to watch GitHub on the Personal account, Vera proposed GitHub (Personal): the ChatGPT app, 91 operations, 50 of them only read. Then she proposed Elias with a source on `github.search_issues`. Her first mapping guessed GitHub's REST shape, and the card's preview failed (below). With the fix, her next proposal fit, keyed by each issue's address. |
| Read at a briefing, browser closed | Two briefings ran from the API with no page open. The collector read the account in code, and Elias's first briefing turn made no call of its own. In the second briefing he had nothing new, so no turn ran for him. |
| A cut-off read says what it held back | The first read held 100 records. Elias was handed the 60 newest, with the note that the rest were recorded as seen, and his report said so. |
| Account isolation | A second service, GitHub (Work), with its own supervisor, Mira. Its source read 2 issues, none of Personal's 100. Asked to call `github.get_user_login` on GitHub (Personal) with Work's `link_id`, Elias got the Personal login, because the daemon sets the account. His call on GitHub (Work) was refused. Nora holds no service. |
| Items open their source record | Mira's item opens the GitHub issue it came from. |
| An unsafe operation is refused before its tick | With nothing ticked, the Operations card's Approve stays disabled and the daemon refuses the approval. Elias can't call the operations. |
| An unsafe operation runs after its tick | The operator ticked both reaction operations and approved. Asked in chat, Elias added a reaction to a pull request and took it back, each call recorded and marked unsafe, and Access listed both grants with their last use. |
| The Access panel | It lists both services with their accounts, each supervisor's operations with when each was last used, both sources with their readers, Nora's cached search, and no unsafe grants. |

### What the proof changed

| Finding | Change |
| --- | --- |
| Most app operations declare no output, so the Chief of Staff guessed a mapping, and only the operator's preview found it wrong. | AiHub reads a service source once when she proposes it. A mapping that doesn't fit goes back to her with the output's shape: field names and kinds of value, never a value. She fixed hers in one try. |
| GitHub's search gives titles, bodies, and links, with state and assignees empty. A briefing turn couldn't call the supervisor's operations, so Elias couldn't check anything and filed nothing. | A briefing turn may call operations that only read, at most 8 times. Unsafe grants never run at a briefing, only in chat or a task. In the second briefing Mira used all 8 calls, then was refused. |
| The Access panel showed a source's approval time as its last read. | Each briefing's read records its time and what it found. |
| A service's 91 operations were listed in Codex's order, and long links in their descriptions widened the chat. | Read-only operations come first, then by name, and the descriptions wrap. |
| The notice for a new supervisor named the service after each of eight operations. | It names it once. |
| The failed-preview hint sent the operator to Access, even for a mapping that didn't fit. | It says what to do in either case. |

### Known gaps from the proof

- Mira spent her 8 calls on broad searches, as her standing instructions said, and found a pull request waiting for review. AiHub left it out of the Inbox because it cited no record the briefing handed her. The briefing text mentions it, without its link.
- Setting up GitHub, the Chief of Staff's chat turns took 64,000 to 190,000 tokens each, mostly on listing 91 operations.
- GitHub's search gives no state or times, so records come in the service's order, and an edit to an issue's text counts as a change.
- Elias guessed the reaction operations' argument names before reading them, so three of his five unsafe calls went to GitHub with the wrong arguments and came back as errors. Each was recorded as an unsafe call.

## Milestone 6: connections from chat (built 2026-11-08)

The operator decided how real integrations work on 2026-11-08:
- AiHub sets up accounts from chat, as it does folders, and nothing is built for one service in particular.
- Every service, source, reader, and tool shows in the office with who has access.
- A connection that breaks the data boundary is allowed when the operator approves it directly.

Staff can't write the part that reaches an account. A reader is safe because it has no network. Code written by staff that holds an account, reads untrusted mail, and reaches the internet could send that mail anywhere. So the code that reaches out is a service the operator approves, and AiHub's code stands between it and the staff. Approving and signing in stay with the operator, and AiHub never sees a password.

| Step | Where it is |
| --- | --- |
| 0. Probe Codex | Done first: What the probe settled, below. |
| 1. Services | `services/services.ts` keeps each service in AiHub's database: a ChatGPT app with one of its linked accounts, or an MCP server by its address or command. Nothing goes into Codex's `config.toml`. The connector process (`runtime/codex-runtime.ts`) runs with apps on and the rest locked down. It gives a service's config only to that service's own thread, where no turn runs. `codex-runtime.test.ts` checks this against the fake app server. |
| 2. Sources on a service | `sources/service.ts`, behind the same source contract as files and folders. A mapping (`sources/mapping.ts`) turns the structured output into records with a key, a version or fingerprint, a title, a time, and a link that must be a web address. A cut-off read says what waits for the next check, and items open their record. Tested in `mapping.test.ts` and `services.test.ts`. |
| 3. Set up from chat | The Chief of Staff has `aihub_list_services` and `aihub_propose_service`. The service card approves, signs in, and checks again. A supervisor's card proposes a source on a service and the operations it may call, and its preview reads the account. An app with several linked accounts needs one named, and the daemon pins its `link_id` on every call. |
| 4. Using it | At the briefing the collector reads the source in code, and the supervisor may look closer with operations that only read, at most 8 calls. In chat and tasks, `aihub_use_service` checks the grant on every call and returns the answer between data markers. Every call is in the activity log. The health check, and any call that finds a lapsed sign-in, say so in the Chief of Staff's chat. |
| 5. Unsafe grants | Ticks on the service card, the hiring card, and a new staff change, Operations (migration v15), which only the operator's request in chat can bring about. A required tick blocks approval. An optional one left unticked isn't granted, and the notice names it. Live search is always unsafe. Unsafe grants never pass to a replacement, and each use is logged as "Unsafe:". |
| 6. The Access panel | `AccessPanel.tsx`, opened from the top bar and from each profile card. Staff tools come from `GET /api/access`, as the gateway gives them. |
| 7. The fake office | `runtime/fake-connectors.ts`: a mail service behind a sign-in, with four made-up messages, one of them a prompt injection, and a ChatGPT app list. In `npm run dev:fake`, "watch my inbox" runs the whole flow, and "let Ines send replies" adds the unsafe send. |

### What trying it in the fake office changed

| Finding | Change |
| --- | --- |
| A supervisor couldn't be given another operation after joining. | The Operations staff change, with the same ticks as the hiring card. |
| A call that found the sign-in gone changed the service's status and nothing else. | AiHub says so once in the Chief of Staff's chat. |
| A failed call read "answered, which answered with an error", and the fake runtime called a failed send sent. | Both fixed. |
| The card still said "Finish signing in" once the service was connected. | The hint goes once it is connected. |
| A record's time showed as a raw timestamp in the preview. | It shows as the office shows times. |

### Known gaps

- Items only worth knowing appear in the briefing's text, not in the Inbox, so the link to their record shows only for items that need the operator.
- The fake mail service forgets its sign-in when the daemon restarts, which `tsx watch` does on every edit. Sign in again from the card.

Not in this milestone:
- Asking the operator before each send: approved unsafe operations run without asking each time. A queue for that is Roadmap phase A.
- Connecting ChatGPT apps from inside AiHub: the operator connects them at ChatGPT.

### What the probe settled (step 0, 2026-11-08)

`npm run spike:connectors` runs it (`spikes/connectors/`):
- **Part A** runs a made-up mail service, an MCP server behind its own OAuth server with two mailboxes, plus a local MCP program. It uses a throwaway Codex home, with no sign-in and no usage.
- **Part B** lists the ChatGPT apps on AiHub's real sign-in. On request it makes one call: here, the GitHub app's login lookup.

No model turn ran.

| Finding | What it means for AiHub |
| --- | --- |
| An MCP server given in one thread's config loads only for that thread. Other threads in the same process list none, and so does the process itself. A local MCP program starts only when its thread does. | A service's config stays in AiHub's database and goes only to connector threads. |
| `mcpServer/oauth/login` signs a service in. Codex registers itself with the service, uses PKCE, and returns an address for the browser, and the redirect comes back to a port Codex opens. A thread started before the sign-in can use it. | The operator signs in from the card: AiHub opens the address and waits for Codex's completion notice. |
| Codex refreshed expired tokens by itself, and sign-ins survived a restart of Codex. | A sign-in lasts until 07:00 with no one at the PC, for as long as the service's refresh token does. The health check still checks each one. |
| Two named servers on one address held two accounts. A thread could call only the servers in its own config. | Work and personal accounts on one MCP service are two services to AiHub. |
| Called from code, Codex ran a tool that sends, and a tool with no labels, without asking anything. | AiHub's gateway is the only boundary between staff and a service's operations. The connector process never runs a model turn, and the daemon calls only what a grant names. |
| Tools keep their labels (`readOnlyHint`, `destructiveHint`, `openWorldHint`) and return `structuredContent` alongside text. | The card shows each operation's label, and a mapping reads records from the structured output. |
| With apps on, a thread gets one server, `codex_apps`, with every connected app's tools. Here that is 198 tools for GitHub, Sites, and ChatGPT Space, all labeled and 105 read-only. It also carries OpenAI's own tools, such as web search. The locked-down features hide all of it. | The connector process runs with apps on, and staff processes keep them off. |
| An app connected with two accounts (GitHub: Personal and Work) needs the account's `link_id` as an argument on every call. The tool's `_meta` lists the accounts by name. Called with one, `github.get_user_login` answered from code. A public repository search timed out at the service twice and came back as an error result. | A connection on an app pins its `link_id`, and the daemon sets it. A tool's error result counts as a failed read. |
| `app/list` lists 5,010 apps, three of them connected here, each with an address for connecting it at ChatGPT. | The Chief of Staff searches the list, and the card links to where the operator connects the app. AiHub can't connect one itself. |

**Decision (2026-11-08):** both paths, behind one kind of service in AiHub: ChatGPT apps for what OpenAI offers, and MCP servers for everything else.

Still open, since the proof used a ChatGPT app:
- Windows Credential Manager as the store for sign-ins. It is Codex's default; the probe used a file so it left nothing behind.
- A real MCP server's sign-in.
- How long a real refresh token lasts.

## Milestone 1: runtime, isolation, and control surface (done 2026-11-07)

| Acceptance | Where it is shown |
| --- | --- |
| The Windows daemon starts Codex, signs in, streams a reply, and invokes a gateway tool through the runtime interface. | `apps/daemon/src/runtime/`: `AgentRuntime` with `CodexRuntime`, contract-tested against a fake app server. Checked against real Codex: a streamed chat reply that called `aihub_get_roster`. |
| The Chief of Staff chat and roster restore after restart, and the chat rebuilds from records when its thread is discarded. | The daemon resumes the saved thread with `thread/resume`; checked against real Codex, where the resumed thread still knew the earlier message. If the thread is gone or its charter or tools changed, a new one starts with recent messages replayed from SQLite (`office.test.ts`). |
| A data-reading run passes the isolation checks. | Every app-server process starts with `LOCKED_DOWN_FEATURES` disabled; data runs get their own process, a read-only sandbox in an empty directory outside any repository, web search off, and only `aihub_submit_report`. In the briefing measurement, a prompt injection in a sample email asked the supervisor to read a canary file and run a command; it reported the email as suspicious and the canary stayed unread. |
| The daemon rejects requests with a foreign `Host` or `Origin` or a missing token. | `apps/daemon/src/security.ts`, tested in `server.test.ts`. |
| A simulated four-section briefing completes, with its turns and usage recorded. | `npm run measure:briefing`; results below. |
| The roster, activity feed, and chat reflect real run state. | `apps/web`, fed by `GET /api/state` and the `/api/events` stream, with the reducer tested in `state.test.ts`. Checked in a browser against the fake runtime (`npm run dev:fake`): streaming replies, queued messages, badges moving from idle to working and back, and recovery after a daemon restart. The daemon serves the built UI from `apps/web/dist`. |

### Usage measured

The simulated briefing on 2026-11-07, Codex 0.167.0, ChatGPT plan "prolite":

| Run | Turns | Input tokens | Cached | Output |
| --- | --- | --- | --- | --- |
| Four supervisor reports (data runs) | 4 | 85,500 | 42,624 | 1,137 |
| Chief of Staff composes the briefing | 1 | 11,513 | 0 | 334 |
| **Total** | **5** | **97,013** | **42,624** | **1,471** |

The whole briefing took about a minute. The plan's primary usage limit read 50% before and after, so one briefing is below what the limit reports. Budget about 21K input tokens per data turn, roughly half of it cached, and about 12K for the compose turn. A chat turn costs about 20K. Sections with nothing new use no turn.

### What the spike settled (step 1, 2026-11-07)

| Finding | What it means for AiHub |
| --- | --- |
| With default features, Codex exposes ChatGPT apps through the `codex_apps` MCP server, including web search. The model searched the web through it even with `web_search = "disabled"`, and no approval request was sent. | Every AiHub Codex process starts with the locked-down feature set. Features apply to a whole process, so data runs get their own process. |
| With the shell tool present, Codex asked for approval before reading the canary file, and AiHub declined. | Declining every approval request is the second line of defense. |
| With the locked-down features, the model found no shell, file, browser, or web tools. | Isolation comes from removing tools, not from the sandbox. |
| The Windows sandbox reports `notConfigured`. | Don't rely on it. If a run ever needs the shell, set it up first (`windowsSandbox/setupStart`) and re-run the probe. |

**Decision (2026-11-07):** Codex is the runtime for all runs, with the locked-down feature set. After every Codex upgrade, run `npm run spike:codex` and `npm run measure:briefing` again. If isolation ever fails, data runs move to the Claude API behind the same runtime interface; it needs an Anthropic API key and is billed per token.

## Milestone 2: staff, memory, and one real source (done 2026-11-07)

The first real source is an `.ics` calendar export. The operator picks the file when approving the proposal.

| Acceptance | Where it is shown |
| --- | --- |
| A chat request produces a proposal, and approving it creates a supervisor with a name, title, and job description, plus its responsibility and routine. | `staff/proposals.ts`, tested in `proposals.test.ts`. Checked against real Codex: asked to watch a work calendar, Vera read the roster and her notes and proposed "Nora, Calendar Supervisor", carrying the operator's "always flag overlaps" as a standing instruction. Approving with the `.ics` created Nora, her responsibility and routine, and a verified connection and grant in one transaction. Approving from the chat card works in the office UI. |
| One real local source feeds a briefing the operator reads daily. | The `.ics` collector (`sources/ics.ts`, `sources/collect.ts`) expands recurrences, keys each occurrence, and diffs against the cursor in code. The scheduler (`scheduler.ts`) runs the briefing at 07:00 Stockholm time on weekdays, with a health check at 06:00, a same-day catch-up, and one retry. Run now is on the Chief of Staff's profile card. Checked against real Codex across three briefings and a calendar edit. |
| An unchanged item is not reported as new the next day, and a dismissed item stays out. | `morning.test.ts`. Against real Codex, the second briefing reported only the moved and cancelled meetings, and the third had nothing new and spent no turn. |
| Ending a mandate blocks further actions under it. | The gateway refuses every tool once a run's responsibility has ended or expired (`gateway.test.ts`, `server.test.ts`). |
| Staff write and read notes in the vault, and a note from a source-data run enters later contexts as data. | `notes/notebook.ts`, tested in `notebook.test.ts`. Against real Codex, Vera wrote a note while proposing Nora. |
| The 2D office is the home screen and renders run state from the event stream. | `apps/web`: the office floor, HUD, profile cards, chat drawer with approval cards, inbox, and notes with backlinks and a graph. Checked in a browser against the daemon in fake mode, from 700 px wide up. |

### Usage measured

The calendar flow on 2026-11-07, Codex 0.167.0, ChatGPT plan "prolite":

| Run | Turns | Input tokens | Cached | Output | Time |
| --- | --- | --- | --- | --- | --- |
| Chat: Vera proposes a supervisor | 1 | 33,844 | 11,008 | 388 | 13 s |
| First briefing: Nora's report, first look at the source | 1 | 47,436 | 35,072 | 499 | 18 s |
| First briefing: Vera composes | 1 | 11,469 | 0 | 109 | 24 s |
| Second briefing, after a calendar edit: Nora's report | 1 | about 23,000 | | | |
| Third briefing, nothing new | 0 | | | | |

A first look at a source costs about twice a later check, since everything in the window is new.

### What the real run changed

| Finding | Change |
| --- | --- |
| The model saw a moved occurrence's raw key, which holds its original time, and called it a contradiction. | Records carry an opaque, stable `evt-` id. |
| A conflict item stayed open after the other meeting was cancelled. | A report can list items still open that no longer apply. AiHub closes only those, under the supervisor's own responsibility, and the journal records why. |
| A missing `overlapsWith` read as "not checked". | Every timed event still on carries the list, even an empty one. |
| A morning with nothing new still spent a compose turn. | Code writes the quiet briefing. |
| Asked again, Vera couldn't tell whether Nora's calendar was connected. | The roster tool shows each staff member's sources and their status. |

### Known gaps

- An `.ics` export is a snapshot: changes show only after the operator exports again, as Vera told the operator herself. Live calendars come with real integrations (Milestone 6).
- The briefing in the Chief of Staff chat is written from source data, and a later chat turn can write notes from it as `conversation`. Mark chat turns that follow a briefing as source data before chat runs more often. Done in Milestone 5.
- The office has no note-removed event, so the UI drops a profile note's old path when a new one appears for the same owner. Unread chat counts live in the browser.

## Milestone 3: teams and delegation (done 2026-11-07)

Acceptance (DESIGN.md): a supervisor recruits a worker with narrowed access, reviews its result, and the worker leaves the office. A staff member asks a colleague a question without holding a turn open, and the answer arrives in a new turn.

1. **Assignments.** An assignment is a question or a task, with a requester, an owner, and either a parent assignment or the conversation it continues in, plus a brief, a run budget, a status, and a result. Runs record their assignment. Run kinds tell the gateway what a run is for: `question` and `assignment` for the owner's work, and `follow_up` when the requester resumes with results. When an assignment settles, the daemon starts the follow-up: a chat turn in the Chief of Staff's conversation, or a run on the parent assignment once all its children have settled.
2. **Asking and assigning.** `aihub_ask_colleague` (Chief of Staff and supervisors) turns a question into an assignment, and the asking turn ends. `aihub_assign_task` lets the Chief of Staff hand a supervisor bounded work within its role. A question run and a follow-up run get neither tool, so nothing nests or loops, and each run checks the daily turn budget first. The question and the answer cross as data, inside markers.
3. **Reading sources on demand.** `aihub_read_calendar` reads a window of a calendar the caller holds a grant for. Grants become the real boundary, so narrowing them means something.
4. **Workers.** `aihub_recruit_worker` (supervisors, in assignment runs) hires a worker with a profile, a task, and a subset of the supervisor's grants, within a cap per supervisor. The worker delivers. In its follow-up run the supervisor accepts each result or asks for one revision with `aihub_review_work`. On acceptance AiHub archives the worker and revokes its grants; its assignment, result, and notes stay.
5. **The office.** Workers walk in and out, a staff member asking a question walks to the colleague's desk, and a profile shows open and recent assignments.

### How it was shown

All five steps are built. Steps 1 to 4 were checked against real Codex, and the office in a browser against the daemon in fake mode, which now delegates too.

| Acceptance | Where it is shown |
| --- | --- |
| A staff member asks a colleague without holding a turn open, and the answer arrives in a new turn. | `staff/delegation.ts`, tested in `delegation.test.ts`. Against real Codex, Vera asked Nora when the standup series started. Her chat turn ended at "I've asked Nora", Nora answered in a `question` run, and Vera passed the answer on in a follow-up turn of the same thread (15,478 tokens in, 14,976 cached). |
| A supervisor recruits a worker with narrowed access, reviews its result, and the worker leaves the office. | Same files. Against real Codex, the operator asked for the recurring meetings that take the most time over two months. Vera assigned it to Nora, and Nora recruited Elias, Calendar Analyst, sharing only her Work calendar. Elias read both months and delivered. Nora re-read the calendar to check his tally and accepted it. Elias was archived with his grant revoked, and his profile note and his own note stayed in the vault. |
| The assignment and result remain inspectable. | Assignments are records with their brief, result, review, and runs used. The Assignments drawer shows them nested by task, including workers who left, and each profile card lists its staff member's assignments. Checked in a browser. |
| The office shows the team at work. | `apps/web`: a worker walks in to a spare desk in its supervisor's pod and walks out when it leaves; a staff member asking a question walks to the colleague's desk; a supervisor waiting on its team shows how many results are in. Checked in a browser against the fake office, where "give Elin a task with a helper" runs the whole chain. |
| Nothing nests or loops. | Run kinds limit the tools (`gateway.test.ts`): a `question` or `follow_up` run can't ask, assign, or recruit, and a worker can't ask or recruit. Caps: 3 open questions per requester, 4 open tasks, 2 workers per supervisor, a run budget per assignment, and the daily turn limit. |

### Usage measured

The delegation runs on 2026-11-07, Codex 0.167.0:

| Run | Input tokens | Cached | Output |
| --- | --- | --- | --- |
| Chat: Vera assigns a task | 36,088 | 23,808 | 252 |
| Nora works the task alone (one week) | 36,380 | 11,520 | 465 |
| Vera's follow-up turn in the chat | 12,766 | 12,160 | 120 |
| Chat: Vera assigns a two-month task | 26,162 | 25,600 | 258 |
| Nora recruits Elias | 23,502 | 11,648 | 246 |
| Elias reads two months and delivers | 75,359 | 50,176 | 1,542 |
| Nora checks Elias's work and accepts it | 40,635 | 26,112 | 593 |
| Vera's follow-up turn in the chat | 13,924 | 13,056 | 129 |
| Nora answers a question | 37,121 | 23,936 | 379 |

A follow-up turn costs little because it continues the chat's own thread: the tool list is the same for every turn of a thread, and the run kind decides which calls go through. A worker reading a long window costs the most.

### What the real run changed

| Finding | Change |
| --- | --- |
| Nora and Elias called their totals "provisional": the calendar reader returned bare occurrences, so a series that starts mid-window, or skips a day, looked like missing data. | `aihub_read_calendar` lists each series once, with its rule, its first occurrence, and the occurrences the file skips in the window. Asked again, Nora answered that the standup is "explicitly skipped" on the offsite day. |
| Given a one-week task and permission to bring in a helper, Nora did it herself. | Kept: a worker is for bounded work that needs reading through a lot, and the instructions say so. |

### Known gaps

- Assignments don't carry their staff members' avatar seeds, so a worker who has left shows an initial in the drawer instead of its portrait.
- An activity entry doesn't say which assignment it is about, so the office can't color a failed task's toast as a failure.
- A refused tool call shows as a toast. With real models refusals are rare, but a confused run can produce several in a row.
- Workers may reuse the name of a worker who has left, so a wikilink to that name can point at either.
- The snapshot holds open assignments and the 30 most recently settled. Older ones stay in the database but not in the office.

## Milestone 4: new sources from chat (done 2026-11-07)

Acceptance (DESIGN.md): the calendar and every new source run through one source contract. Two new responsibilities are set up from chat on local folders with no code change: one in a format a built-in reader covers, and one whose reader a toolsmith writes and the operator approves. One supervisor can't read another's source, and an unapproved or changed reader never runs. The operator can open a chat with any staff member from the office.

Earlier this plan hand-built readers for mailboxes and a portfolio. It changed on 2026-11-07 so that new sources come from chat instead of from code, and nothing in it asks the operator to connect an account. Tests and the fake office use made-up sample files.

1. **One source contract.** `sources/source.ts`: an adapter verifies a connection, hands over what changed since its cursor (keyed and versioned records), and reads records for a question. The calendar is the first adapter. The briefing goes through it, and `aihub_read_calendar` became `aihub_read_source`, checked against the caller's grants.
2. **Folder sources.** A connection to a folder, with a file pattern and a reader. Built-in readers: markdown (one record per note, frontmatter as fields), plain text, CSV (one record per row, keyed by an id column or its content), and JSON. The daemon reads only matching files inside the folder: no hidden entries or links, at most 2,000 files, 2 MB each, and 50 MB in all. A first check hands over a sample, and a big change is cut at 60 records with the rest held for the next check. The Chief of Staff's proposal names the reader, and the operator picks the folder on the card.
3. **Readers written by staff.**
   - The box (`sources/sandbox.ts`): QuickJS compiled to WebAssembly, in a worker thread. Each file gets a fresh runtime with no host objects, 32 MB of memory, and 1 second, within 10 seconds per run. A native loop QuickJS can't interrupt is stopped by killing the worker. Only JSON comes out, and the daemon checks it as records.
   - A reader is `function read(file)` returning `{ key, title, fields }` records.
   - When no built-in reader fits, the Chief of Staff calls `aihub_commission_reader` with a description and sample files. A toolsmith joins as the Chief of Staff's worker with no sources, tests with `aihub_test_reader` on the samples, hands in with `aihub_submit_reader`, and leaves once its task settles. Those two tools exist only for a toolsmith with a reader to write.
   - The Chief of Staff then proposes a supervisor whose folder names the reader. The card shows the code and the toolsmith's notes, and Approve waits for a preview of the real folder. Approving the supervisor approves the reader and pins its code by hash: only that code runs, and only in the box.
   - In the office, the toolsmith walks in to a lounge desk, works there with a wrench, and walks out after handing in.
4. **Chat with anyone.** Any staff member's profile opens a chat with them. A supervisor's or worker's chat runs in its data profile, with its own sources, and its turns count as source data. A chat with someone who has left stays readable.
5. **The proof.** Below.

### How it was shown

Against real Codex, with made-up files: a reading list of four markdown notes, and two monthly bank statements in a fixed-width layout with a header block and Swedish amounts.

| Acceptance | Where it is shown |
| --- | --- |
| Every source runs through one contract. | `sources/collect.ts` picks the adapter by kind; `collect.test.ts`, `folder.test.ts`, and the briefing tests run the calendar and folders through it. |
| A responsibility on a built-in reader, set up from chat. | Asked to watch the reading list, Vera proposed Clara with a markdown folder in one turn. The card's preview listed the four notes with their frontmatter; approving connected them. In the briefing Clara flagged the library book due back in seven days. |
| A responsibility on a reader the toolsmith writes, set up from chat. | Given October's statement pasted into chat, Vera commissioned a reader. Oskar tested on the sample, then on two edge cases of his own (CRLF, a duplicate row, malformed rows), handed in a 47-line reader, and left. Vera proposed Ingrid with it. The preview read 13 transactions from both files, and the card showed the code. In the briefing Ingrid flagged the double Spotify debit and the 14,995 purchase. |
| One supervisor can't read another's source. | `aihub_read_source` reads only granted connections (`folder.test.ts`, "lets a supervisor read only the sources it holds a grant for"), and a staff member's notes are readable only by it and the staff above it (`notebook.test.ts`). Asked for the bank balance in Clara's own chat, Clara replied that the statements were out of reach. |
| An unapproved or changed reader never runs. | `toolsmith.test.ts`: a connection naming a reader before approval reads nothing, and approved code changed in the database is refused. Against real Codex, with the approved code changed in the database, Ingrid's read was refused ("The reader for this folder isn't approved, so AiHub won't run it"), and Ingrid said so; with the approved code restored, Ingrid answered from the statements again. |
| The box holds. | `sandbox.test.ts`: no host objects; `require`, `process`, `fetch`, timers, and dynamic import all fail without touching files or the network; endless loops, native loops, unbounded allocation, deep recursion, huge output, and bad records each fail cleanly, and the next file still runs. |
| The operator can chat with any staff member. | `office.test.ts` "Chat with any staff member", and in the browser: a profile's Chat button opens the chat, with a way back to the Chief of Staff's. Against real Codex, Ingrid answered from the statements in a direct chat. |
| The office shows it. | Checked in a browser against the fake office, where "watch my reading list" and "write a reader for my bank export" run both flows: the toolsmith walks in and out, the card gates Approve on a preview, and profiles show each folder's reader. |

### Usage measured

The proof runs on 2026-11-07, Codex 0.167.0:

| Run | Input tokens | Cached | Output |
| --- | --- | --- | --- |
| Chat: Vera proposes Clara (reading list) | 39,694 | 26,112 | 330 |
| Chat: Vera commissions a reader | 42,214 | 27,904 | 516 |
| Oskar writes, tests three times, and hands in | 82,342 | 53,632 | 1,705 |
| Vera's follow-up proposes Ingrid | 45,290 | 43,136 | 351 |
| Clara's briefing report | 35,102 | 23,168 | 337 |
| Ingrid's briefing report | 52,923 | 43,392 | 549 |
| Vera's briefing | 11,476 | 0 | 169 |
| Ingrid answers in a direct chat | 35,822 | 22,272 | 185 |
| Clara declines the bank question | 11,091 | 0 | 44 |

Writing a reader costs about one supervisor report and a half, once. Reading the folders costs no model turns: the collectors and the box do it.

### What the real run changed

| Finding | Change |
| --- | --- |
| Ingrid's first read guessed the source was called "Monthly bank statements" and was refused before retrying. | Instructions list the sources a staff member holds, by the names `aihub_read_source` takes. Asked again, Ingrid used the right name first. |
| Vera took the reader's name, "Sample Bank statements", from the made-up header. | Kept: the Chief of Staff names readers from what the operator shares, and the card shows the name before anything runs. |

### Known gaps

- A reader can't be revised. A changed format needs a new reader under a new name, and a reader handed in for a declined card stays waiting with nothing to retire it.
- A read refused in chat, such as by a changed reader, doesn't mark the connection failed. The next briefing or health check does.
- Readers see the real clock and random numbers. The toolsmith's charter asks for deterministic code; nothing enforces it.
- A deadline can run over by about 0.7 seconds when the box has to kill and replace its worker.
- The box's worker loads through Node's own type stripping, since tsx doesn't reach worker threads. Before Node 22.18 that takes a flag, which AiHub adds, and a bundled build would need the worker as its own entry.
- Each check reads the whole folder again; nothing skips unchanged files yet.

Not in this milestone: live accounts such as mail or a broker (Milestone 6, probably through existing MCP servers), briefings with the browser closed or after sleep (Milestone 5), drafts and sending (Roadmap phase A), and staff with a shell (Roadmap phase B).

## Milestone 5: background operation (done 2026-11-08)

Acceptance (DESIGN.md): briefings and alerts arrive with the browser closed and after the PC wakes from sleep. Tests cover restart, duplicate triggers, stale data, revoked access, failed supervisors, exhausted Codex usage, and an expired sign-in caught by the health check. Responsibilities with nothing new use no model turn.

Already in place from earlier milestones: the daemon, not the browser, schedules the briefing; occurrences are claimed once, so a retry or restart never delivers twice; a missed briefing catches up later the same day; the health check runs an hour before; and a quiet section uses no model turn.

1. **Runs in the background.** `npm run windows -- install` registers a Task Scheduler task that starts the daemon at Windows sign-in, under the operator's account, with no window. It serves the built office on `127.0.0.1:7420`, writes its log to `data/logs/`, and a second copy exits when one is already running. `uninstall` removes everything it added, and `status` says what is installed. A Start menu entry opens the office.
2. **Wakes for the briefing.** The installed daemon keeps one Task Scheduler task with "Wake the computer to run this task", set for two minutes before the next health check, or before a waiting briefing's next try. When it fires it only starts the daemon if it isn't running; the daemon still decides what runs. From the health check until the briefing settles, the daemon asks Windows to stay awake, since a PC woken by a timer goes back to sleep after a couple of minutes. `status` says whether power settings allow wake timers.
3. **Alerts outside the browser.** Windows notifications for a delivered briefing (with its count of new and urgent items), problems the health check finds, and a briefing that is waiting or has given up. They carry counts, never source content. Clicking one opens the office. `AIHUB_NOTIFICATIONS=off` turns them off.
4. **Waiting instead of failing.** Codex turn errors are sorted into used-up usage, signed out, offline, busy, or other. Before its first turn the briefing checks that Codex is signed in, reachable, and has usage left. When that check fails, or a turn fails, the briefing waits with the reason in the chat and a notification, and tries again when the reason may have passed: a minute after usage resets, or in 10 to 15 minutes, until the end of the day. Its changes stay unreported, so the next briefing still covers them.
5. **The failure cases, tested.** Restart during a briefing, duplicate triggers (two schedulers on one database), a stale calendar export (older than a week: the health check and the section say so), revoked access (the section says the supervisor can't read its source, with no model turn), a supervisor whose run fails (the briefing still goes out and names the gap, and its changes are reported next time), used-up usage, and an expired sign-in caught by the health check.
6. **Source data after a briefing.** Once a briefing or another source-data turn enters a chat's thread, every later turn in that thread counts as source data, so a note written from it can't pass as the operator's word. A new thread starts clean.
7. **The proof.** Below.
8. **A tray icon**, added after the proof. The background daemon shows an icon in the notification area through a Windows PowerShell helper, like the stay-awake one. A click opens the office; the menu shows the next briefing and what needs the operator, in counts, and opens the notes and quits AiHub. The Start menu entry became a shortcut that starts AiHub through its sign-in task when it isn't running, then opens the office. `npm run windows` asks the daemon to quit before it ends the process, so the icon goes away cleanly.

Not in this milestone: phone notifications and approvals away from the PC (Roadmap phase C), live accounts (Milestone 6), and running without a signed-in Windows session.

### How it was shown

On this PC, against real Codex, with AiHub installed under a test name (`--windows-name=AiHubProof --port=7431`) on a copy of the Milestone 4 proof office, and uninstalled afterwards.

| Acceptance | Where it is shown |
| --- | --- |
| Briefings and alerts arrive with the browser closed. | Running the sign-in task as Windows would started the daemon with no window. With no browser open, Run now delivered the briefing in 21 s. Its notification, "Your briefing is ready: 1 new item.", is in Windows' notification history under AiHub's app id, set to open the office. A second copy said AiHub was already running and exited. |
| Briefings arrive after the PC wakes from sleep. | The wake task stood in Task Scheduler with "Wake the computer to run this task", set for 05:58 the next weekday, and `status` reported wake timers allowed on mains power and off on battery. The stay-awake helper held while the briefing ran and let go when it was done (`scheduler.test.ts`, "keeps the PC awake from just before the health check until the briefing is in, and sets the next wake"; `windows-platform.test.ts`). Putting the PC to sleep is left to the operator. |
| Restart and duplicate triggers. | `scheduler.test.ts`: a briefing cut off by a restart is tried once more after a pause, a waiting briefing keeps waiting across a restart, and two schedulers on one database start each briefing once. |
| Stale data, revoked access, and failed supervisors. | `morning.test.ts`, "Morning briefing when something is wrong", and `scheduler.test.ts`: a week-old export is named in the health check and in its section; a supervisor whose access was removed gets a section that says so, with no model turn; a supervisor whose run fails leaves a gap the briefing names, and its changes come back next time. |
| Used-up Codex usage. | `morning.test.ts` and `scheduler.test.ts`: with usage used up the briefing runs no turn and waits until a minute after the reset. Against real Codex, `npm run probe:failures` read the plan's usage (50% of the window, resetting at 11:05). |
| An expired sign-in caught by the health check. | `scheduler.test.ts`. Against real Codex, `npm run probe:failures` ran an office on a Codex with no sign-in: the health check posted "Codex isn't signed in. Sign in with `npm run codex -- login`." in the chat and as a notification, and the briefing waited for 07:15 with no model turn. The same probe ran Codex with its connection pointed at a closed port: the briefing waited for 07:10. Signing the real account out and in is left to the operator. |
| Responsibilities with nothing new use no model turn. | In the proof briefing Nora and Ingrid had nothing new and used no turn; only Clara, with the library book, did. A later briefing with nothing new anywhere used none. |
| Source data stays marked in a chat. | `office.test.ts`, "Source data in a chat's thread". Against real Codex, asked about the briefing in the same chat, Vera answered "due back Thursday 12 November" and wrote a note about it, saved as source data. |

### Usage measured

The proof runs on 2026-11-07 and 2026-11-08, Codex 0.167.0:

| Run | Turns | Input tokens | Cached | Output |
| --- | --- | --- | --- | --- |
| Clara's briefing report (one new item) | 1 | 34,682 | 11,136 | 251 |
| Nora's and Ingrid's sections (nothing new) | 0 | | | |
| Vera's briefing | 1 | 11,282 | 0 | 119 |
| Chat: Vera answers about the briefing and writes a note | 1 | 63,080 | 61,824 | 229 |
| A briefing with nothing new | 0 | | | |
| A briefing waiting for sign-in or a connection | 0 | | | |

A waiting briefing costs nothing while it waits. A chat turn after a briefing costs more input than a fresh one because the briefing comes into the thread, but nearly all of it is cached.

### What the real run changed

| Finding | Change |
| --- | --- |
| With no connection, Codex doesn't report a connection error. A turn fails after about a minute with a generic error ("workspace routing discovery failed"), and the account check fails too, which AiHub read as signed out. | A Codex that can't answer the account check reads as offline. After any failed turn the briefing runs its check again, and waits if Codex can't answer it. `npm run probe:failures` produces these cases without touching the real sign-in. |
| The sign-in notice repeated Codex's own message next to AiHub's ("Not signed in. Run … Sign in with …"). | Each problem is one sentence AiHub writes. |
| A health check with one problem said "a few things need you". | The notice counts them, as the notification already did. |
| A daemon started with `npm run dev` also set the wake task, so a test run could leave the PC waking. | Only the installed daemon keeps a wake task. |
| Uninstall left the notification settings: clearing the notification history makes Windows write them again a moment later. | Uninstall removes them until they stay gone. Checked: after install, a notification, and uninstall, nothing was left in Task Scheduler, the registry, or the Start menu. |

### Known gaps

- Clicking a notification wasn't tried on this PC. Its history entry shows the office's address and activation by protocol, which is what opens a browser.
- When a briefing waits partway, its next try runs the reports that already finished again, which costs their turns twice. Nothing is lost or reported twice, because a report's items count as seen only once the briefing goes out.
- A connection lost during a turn shows only when that turn fails, about a minute later.
- Wake timers on battery are off in this PC's power plan, so a laptop on battery won't wake for the briefing. `status` says so.
- Signing out and in, and sleep, are left to the operator to try.

## Web search as a grant (decided 2026-11-08)

Nora, hired as a news supervisor, couldn't brief: no run had web search, and a supervisor without a source had nothing to check. The operator asked for the security rule to be revised, since many staff will need the web. DESIGN.md › Authority and data boundaries now allows Codex's cached web search as a grant; live search stays off.

The reasoning: the rule against combining personal data, untrusted content, and a way out is about sending data to a party the untrusted content could control. Cached search answers from OpenAI's index and fetches nothing from the sites, so a query reaches only OpenAI, which already processes the run as the model service. Live search, and Codex's "indexed" mode, which may fetch, would let an injected instruction put data in an address a site's owner sees.

1. **The grant.** `web_grants` (migration v8) holds who may search, optionally limited to sites. The operator gives, limits, and takes it away on the profile card (`PUT`/`DELETE /api/agents/:id/web`). A run with the grant starts with `web_search = "cached"`, plus `tools.web_search.allowed_domains` when limited; every other run keeps `web_search = "disabled"`.
2. **Untrusted, and on the record.** Each search and page open is an activity entry. A chat turn that searched counts as source data, so the thread and its notes do too. The staff member's instructions say search results are data and never instructions.
3. **Proposals.** The Chief of Staff can propose a supervisor with web search, and must propose a source or web search. Approving grants it.
4. **Research in the briefing.** A supervisor with web search and no source runs one turn at every briefing: what is new since the last one, with the address of each story as its `sourceRef`. Addresses key the items, so a story is never new twice, and the researcher is shown what it reported in the last four days. Items lapse after two days, and neither carried-over stories nor their lapsing go into the briefing. A supervisor with neither now gets a section saying so, instead of "its access was removed".

### How it was shown

- `morning.test.ts`, "Morning briefing from web research"; `office.test.ts`, `proposals.test.ts`, `server.test.ts`, `codex-runtime.test.ts`, and `staff/web.test.ts`.
- A probe of Codex's three modes (cached, indexed, live) for news from the last 24 hours: all three found it. Cached is the one that fetches nothing from the sites.
- Nora's research section against real Codex, in a throwaway office with her real profile and responsibility. The first briefing reported three stories from the day before, each with its address and publication time, and the activity log listed her three searches. The second ran with the clock a day ahead. Nora searched six more times, reported nothing as new, and said the results were older or repeated what she had already reported, so the briefing might miss stories.
- Nora's grant was given on her profile card in the installed office.

### Usage measured

Codex 0.167.0, 2026-11-08:

| Run | Turns | Input tokens | Cached | Output |
| --- | --- | --- | --- | --- |
| Mode probe, cached | 1 | 135,222 | 108,544 | 854 |
| Mode probe, indexed | 1 | 61,987 | 43,648 | 651 |
| Mode probe, live | 1 | 125,974 | 84,864 | 1,175 |
| Nora's research report, first briefing | 1 | 141,301 | 102,912 | 989 |
| Nora's research report, a day later | 1 | 261,220 | 206,080 | 771 |

Search results come back as input, so a research report takes four to eight times the input of a calendar report (34,682 for Clara's), most of it cached. It runs at every briefing, even on a quiet morning.

### Known gaps

- Briefings ran on weekdays only, though Nora's responsibility mentions weekends. Weekend briefings followed the same day, below.
- A supervisor with both a source and web search reads only its source at the briefing. Web search is there in its chat and tasks.
- Workers don't get web search, even when their supervisor has it.
- The cached index can lag the news. In the probe, the newest stories were from the day before.
- Live web search isn't offered. If it comes, it is only for staff with no personal data (DESIGN.md).

## Weekend briefings (2026-11-08)

The operator asked for weekend briefings, for Nora's news. The briefing routine's trigger can now be `daily` as well as `weekdays`, switched with Weekends too on the Chief of Staff's profile card (`PATCH /api/routines/:id`). Everything that followed weekdays now follows the routine's days: the health check, the wake timer, the next run the UI and the tray show, and catching up later the same day. Turned on after the day's briefing time on a weekend, that day's briefing is skipped rather than run late. A weekend with a briefing adds to the streak, and one without never breaks it. Tests: `scheduler.test.ts` and `server.test.ts`.

## Office policy (2026-11-08)

The operator asked for a company policy like a root AGENTS.md, for the whole staff, that only the operator and the Chief of Staff can edit. The operator chose "She proposes, I approve": an injected instruction in a source Vera read could otherwise become a rule for every staff member. The policy is versioned in `policy_versions`, and the current one is the newest approved. It enters every run's instructions (`staff/identity.ts`). The operator writes it in the Policy panel (`PUT /api/policy`). Vera proposes with `aihub_propose_policy`, only in chat, and the card in her chat approves or declines it (`POST /api/policy/:id/approve|decline`). Tests: `staff/policy.test.ts`, `server.test.ts`, and `lib/policy.test.ts` and `state.test.ts` on the web side.

### How it was shown

In a throwaway office on real Codex, the operator told Vera "A rule for the whole staff from now on: always write to me in English, and anything about money counts as urgent the same day." She proposed both rules with the tool in one turn, and the card showed them as added lines. After approval, the operator asked her to drop the English rule and add one about notes. Her proposal kept the money rule word for word, so she read the current policy from her instructions, and the card showed the removed line struck through. Declining it, editing the policy in the panel, and the earlier versions list all worked. The installed office has no policy yet; the operator writes the first one.

### Usage measured

Each proposal was one chat turn: 37,376 tokens for the first and 24,915 for the change. The policy adds its own length to every run's instructions, about 1,000 tokens at the 4,000 character limit.

### Known gaps

- Only Vera proposes. Other staff who notice a rule worth having would tell her or the operator.
- Declining from the card gives no reason, though the API takes one.
- A proposal from a chat that read source data is marked on the card, not blocked.
- The policy lives in the database, not the vault, so Obsidian doesn't show it.

## Models and reasoning (2026-11-08)

The operator found no way to see which model and reasoning level staff run on, and asked for it to be configurable, observable, and for the Chief of Staff to pick a fitting one for each supervisor. Until now AiHub never named a model, so every run used Codex's default: GPT-6.1-Sol at its default, low reasoning. Agents now hold an optional model and level, and runs record what they ran on (migration v10). The office reads the catalog with Codex's `model/list`, keeps it for an hour, and names the resolved model and level on every `turn/start`. The profile card shows and changes them (`GET /api/models`, `PUT /api/agents/:id/model`). Vera's `aihub_propose_supervisor` requires a model, checked against the catalog, and `aihub_list_models` lists it for her. Tests: `staff/models.test.ts`, `codex-runtime.test.ts`, `office.test.ts`, `proposals.test.ts`, `server.test.ts`, and `lib/models.test.ts` on the web side.

### How it was shown

The sign-in offers eight models, from GPT-6.1-Sol (the default, low reasoning) and GPT-6-Astra (frontier, medium) to GPT-6-Luna (fast, medium) and older 5.6 models, each with low to max reasoning, plus ultra on most. A probe also showed that Codex accepts a model it doesn't offer at `thread/start`, so AiHub checks every choice against the catalog itself. In a throwaway office on real Codex, the operator set Vera to GPT-6-Luna at low reasoning on her profile card and asked for someone to brief them on Swedish electricity prices. Vera listed the models, proposed Elsa with web search on GPT-6-Luna at low reasoning ("routine daily price lookup and concise scheduling recommendations suit the fast, low-reasoning model"), and the card showed it. Codex's own saved session for that turn records `gpt-6-luna` at `low`. After approval Elsa runs on the same, and the notice says so.

### Usage measured

The hiring turn on GPT-6-Luna at low reasoning was one turn of 49,337 tokens, including the model list and the proposal. The installed office keeps every staff member on the default until the operator changes one, so its usage doesn't change.

### Known gaps

- The approval card shows Vera's pick but doesn't change it; the operator changes it on the profile card after hiring.
- There is no office-wide default of AiHub's own: the office default is whatever Codex marks as its default.
- Fast service tiers, which Codex offers for most models at more usage, aren't offered.
- A worker starts on its manager's choice; the supervisor doesn't pick for it.

## Views (2026-11-08)

The operator asked for staff to answer with interface where it reads better than text, and loosened the planned rules before it started: no benchmark gate, outside images in chat and on dashboards behind a click, and no data limits on dashboards beyond read-only. DESIGN.md › Office experience › Views has the rules as built.

1. **One component library.** `packages/views` defines the components a view may use (text, headings, badges, callouts, key numbers, tables, bar and line charts, lists, timelines, links, images, buttons, selects, toggles, cards, and tabs) as zod schemas in [OpenUI Lang](https://github.com/thesysdev/open-intelligent-ui). The daemon checks programs against them, the web app draws them, and the guide staff read is written from them. It uses `@openuidev/lang-core` and `@openuidev/react-lang` 1.1, not Thesys's hosted service. The `lang-core` install script is turned off, and the packages' developer tools never mount.
2. **Handing a view in.** `aihub_view_guide` returns the guide for a reply or a dashboard. `aihub_show_view` puts a view under a chat reply or on the caller's briefing section, and `aihub_save_dashboard` (the Chief of Staff and supervisors, in chat) saves or replaces a dashboard by title. Each program is checked when it arrives and the problems go back to the staff member. After three failed checks in a run, the tool says to answer in text. A reply holds three views, a section one, and the office 30 dashboards. Views live in the `views` table (migration v11).
3. **Dashboard data.** Six read-only data tools (`office_items`, `office_runs`, `office_usage`, `office_staff`, `office_assignments`, `source_records`) answer `POST /api/views/data` when a dashboard opens or a filter in it changes. `DELETE /api/views/:id` removes one.
4. **Drawing them.** Views load with the first one shown, as their own 218 KB chunk (67 KB gzipped). Charts follow the dataviz method: one axis, thin marks, a legend from two series, hover and arrow-key values, a table a click away, and a categorical palette checked for color vision deficiency on both themes. Views show under replies, on the briefing's paper with their author's name, and in the Dashboards tab with Refresh, Ask (a chat with the author, ready for a question), and Remove. A button's tooltip reads its action; outside images wait on a placeholder naming their site, except on a section by a supervisor with no sources.
5. **The fake office** shows a chart for "show me a chart", saves a dashboard for "make me a dashboard", and adds a list view to a report section.

### How it was shown

- Tests: `views.test.ts` in `packages/views` (the check, including the guide's own examples and refusing anything that writes, and the guide), `views/views.test.ts` in the daemon (handing in, the caps, section views, dashboards, and the data tools over a real office), `server.test.ts` (the data and remove routes), and `lib/views.test.ts` and `state.test.ts` on the web side.
- In a browser against the fake office: a chart under a chat reply with its tooltip and table, a dashboard whose filter queries again, Ask filling the author's chat box once, a section view on the briefing's paper, and both themes.
- Against real Codex, in throwaway offices:
  - Asked for a week of finished tasks as a chart, Vera read the guide, handed in "Tasks finished this week" on the first try, and named Thursday in her reply.
  - Asked for a dashboard of how much the office works, Vera saved "Office workload" on the first try. It opened in the production build under the page's CSP, and its data requests answered.
  - Asked for Sunday's hourly SE3 prices with the cheapest hours marked, Elsa (web search, GPT-6-Luna at low reasoning) searched, read the guide, and handed in a 24-hour bar chart with 02–04 highlighted, on the first try.
  - Three briefings with Clara, Ingrid, Nora, and Elsa handed in no section views. Ingrid's five new transactions and Elsa's unpublished prices read fine as text, which is what the instructions ask.

### Usage measured

Codex 0.167.0, 2026-11-08:

| Run | Model | Input tokens | Cached | Output | Time |
| --- | --- | --- | --- | --- | --- |
| Chat: Vera charts a week of tasks | GPT-6.1-Sol | 44,276 | 28,288 | 186 | 12 s |
| Chat: Vera saves a dashboard | GPT-6.1-Sol | 79,490 | 73,472 | 505 | 18 s |
| Chat: Elsa charts the day's prices from web search | GPT-6-Luna, low | 111,828 | 83,072 | 462 | 18 s |
| Elsa's briefing report (no view) | GPT-6-Luna, low | 79,053 | 34,688 | 458 | |

The guide costs about 2,800 tokens for a reply and 5,000 for a dashboard, only in the turns that read it. A chart turn costs a little more than a plain chat turn (about 35K input), and a dashboard turn about twice as much, most of it cached. Opening a dashboard costs no turn.

### What the real run changed

| Finding | Change |
| --- | --- |
| On Elsa's 24 narrow bars at chat width, the values over the three highlighted hours ran into each other. | Highlighted values are labeled only when every one fits; otherwise the tooltip and the table carry them. |
| The chart's long title squeezed the Table switch onto two lines. | The switch never wraps. |
| A chat view repeated its title above its own heading. | Only a section view shows a title, with its author's name. |
| In development, OpenUI's developer tools mounted on the page, with links to Thesys's cloud. | They are turned off before the renderer loads. |
| The office asked for `/api/models` before its session started, and the first request failed. | It waits for the first snapshot. |
| The operator's first dashboard in the installed office asked `office_assignments` for a `limit`, which only the other list tools took. The check looked at tool names only, so the error showed when the dashboard opened. | Every list tool takes a `limit`, and the check tests each query's written-out arguments against its tool, so the staff member fixes them in the same turn. |

### Known gaps

- No maps, embedded pages, or services AiHub picks itself: images and links only.
- No per-model benchmark. The failure cap stands in, and GPT-6.1-Sol and GPT-6-Luna each wrote valid programs on the first try.
- Outside images in chat always wait for a click, even from staff who hold no personal data.
- Supervisors rarely add section views, by design of their instructions; none has appeared in a real briefing yet.
- `office_staff` gives roles as ids, such as `chief_of_staff`.
- A dashboard doesn't update as the office changes while it is open; Refresh reads again.
- A button's message for the assistant sends only its visible text. OpenUI's hidden context for the model is dropped, so the operator sees everything that is sent.
- Numbers in key numbers and table cells show as the staff member wrote them; only charts format them.

## The Inbox holds what needs the operator (2026-11-08)

The operator found Nora's news stories in the Inbox with Resolve and Dismiss, and asked what there was to resolve. Every finding had become an item that waited there, which fits a meeting clash but not a story to read. The operator chose to keep the Inbox for findings that need them to do or decide something.

1. **Each finding says whether it needs the operator.** `aihub_submit_report` requires `needsOperator` on every item, and the report instructions say when it is true. Items keep it (migration v12, which marks stories keyed by a web address as only worth knowing). A web researcher's findings are always only worth knowing, whatever it says.
2. **Only items that need the operator wait in the Inbox.** The Inbox, its badge, the desks' counts on the office floor, and the tray menu count only those. The rest are told once in the briefing: they aren't carried over as still open, and they lapse after two days, or sooner when their source record stops mattering, without a mention in the next briefing.
3. **The briefing puts what needs the operator first.** The Chief of Staff sees `needsOperator` on each new item. The notification says how many of the new items need the operator when it isn't all of them, such as "3 new items, 1 needs you."
4. **Dashboards can tell them apart.** `office_items` returns `needsOperator` and filters on it, and the guide's dashboard example lists only what the Inbox holds.

### How it was shown

- Tests: `morning.test.ts` ("tells what is only worth knowing once": not carried over, and lapsing quietly; and that news is only worth knowing), `lib/office.test.ts` (the Inbox, its counts, and the desks leave such items out), and the existing briefing, gateway, and scheduler tests with the new field.
- The migration on a copy of the installed office: Nora's three open stories left the Inbox, and nothing else changed.
- In the fake office, whose supervisor flags clashes as needing the operator and other changes as worth knowing: the Inbox and the desks showed the clashes and the demo's open items, not "Vendor demo cancelled", and the composed briefing carried `needsOperator` on each item.
- Against real Codex, in a copy of the Milestone 4 proof office with three calendar changes: Nora marked the new call that clashes with standup and the budget sign-off that needs the Q4 numbers as needing the operator, and the 1:1 with Erik moving to 15:00 as only worth knowing. The briefing led with the clash as a decision, and the Inbox gained the two. Her report took 24,085 input tokens (12,032 cached) and 365 output, about what a calendar report took before.

### Known gaps

- Items from before the change keep needing the operator, except stories keyed by a web address. The operator resolves or dismisses the rest once.
- A finding counts as worth knowing or not when it is first reported. A supervisor who later thinks otherwise about an unchanged record can't change it; a new version of the record can.
- A web researcher's finding never needs the operator, even one that is a recommendation, such as running the dishwasher before prices rise.
- A finding only worth knowing shows in its briefing and on dashboards, and nowhere else. The Inbox has no list of them.
- A lapsed item counts toward its supervisor's experience like a resolved one, as research items did before.

## The Chief of Staff reviews the staff (2026-11-08)

The operator wanted the Chief of Staff to run the staff over time: catch blockers, and suggest changing, replacing, ending, or adding supervisors when something needs to improve, without it happening all the time. They took the proposed defaults: a review when code finds a warning sign, counts and decisions only, every change on an approval card, and a short message in her chat only when there is something to suggest. DESIGN.md › Staff review has the rules as built.

1. **Warning signs, found by code.** After each delivered briefing, AiHub records each supervisor's section and looks for four signs: a section missing twice in a row, a source unreadable three times in a row, the operator dismissing at least three and most of a supervisor's findings that needed them in 14 days, and nothing found in 14 days by a supervisor who has been there that long. A new sign starts a review (a run of kind `review`); one that still stands a week later starts one more, and then none until it clears. At most one review runs a day. `POST /api/staff-review` and Review now on her profile card start one at any time.
2. **Counts only.** The review's input is built from records: each supervisor's scope and standing instructions as approved, model, section history, runs by kind and outcome, share of the office's usage, findings by kind and the operator's decisions, and the staff changes and hires of the last 30 days with their outcomes. It never holds what was reported, item titles, or notes, and the run has no memory and no notes tools. Its only tools are `aihub_list_models`, `aihub_propose_supervisor`, and `aihub_propose_staff_change`.
3. **Staff changes.** `aihub_propose_staff_change` (the Chief of Staff, in a review or in chat) proposes new scope or standing instructions, another model or reasoning level, ending a responsibility, or a replacement. Changes live in `staff_changes` (migration v13), at most three per review and one waiting per supervisor. Approving checks the supervisor and responsibility are as they were when proposed; ending or replacing also waits for open questions and tasks. A replacement takes over the responsibility, its routines, sources, web search, and items, and the old supervisor leaves.
4. **In the office.** A review that proposes something posts a staff review message in her chat, then a card per change, with a diff for instructions, now and then for a model, and the new person for a replacement. With nothing to suggest it posts nothing and her journal says why. The tray menu and the proposal bubble count waiting staff changes.
5. **The fake office** proposes narrower instructions for the first supervisor named in a sign, or for the first supervisor when asked with Review now.

### How it was shown

- Tests: `staff/review.test.ts` (the cadence, the four signs, an input without reported text or notes, the review's tools, message before cards, the cap, validation, a newer change replacing a waiting one, conflicts on approval, ending with an open assignment, replacing, declining, and the journal's reason), `scheduler.test.ts` (a review after the second missing briefing), `gateway.test.ts`, `server.test.ts` (the routes), and `state.test.ts` (a late copy can't reopen a decided change).
- In a browser against the fake office: Review now, the staff review message and its card in Vera's chat, Approve and its notice, and both themes.
- Against real Codex, in copies of the views office (Nora, Clara, and Ingrid, one day in):
  - With no sign, Vera found nothing to suggest.
  - After the operator dismissed three of Nora's five findings that needed them, she proposed in two of five runs to keep Nora's standing instructions and add when a finding needs the operator, with a reason quoting the dismissals. In the other three she let the sign stand. In the last of them, her journal said the staff were one day in and no dismissal reasons were recorded, so the numbers didn't support a change yet.

### Usage measured

Codex 0.167.0, 2026-11-08, Vera on GPT-6.1-Sol at low reasoning:

| Review | Input tokens | Cached | Output | Time |
| --- | --- | --- | --- | --- |
| No sign, nothing to suggest | 12,840 | 0 | 35 | 8 s |
| Nora's dismissals, nothing to suggest | 12,878 | 9,216 | 118 | 13 s |
| Nora's dismissals, a change proposed | 41,372 | not recorded | 346 | |
| Nora's dismissals, a change proposed | 55,860 | not recorded | 391 | |

The input itself is about 1K tokens for three supervisors; the rest is the charter and tools. A review with nothing to suggest costs less than a chat turn, and one that proposes about two.

### What the real run changed

| Finding | Change |
| --- | --- |
| When Vera let a sign stand, her reasoning was lost, and nothing showed why. | She gives one sentence on why, which goes in her journal, not the chat. |
| Review now wrapped onto two lines on her profile card. | Buttons in the routine list never wrap. |
| Vera let Nora's sign stand partly because no dismissal reasons were recorded: Dismiss took none. | Dismiss asks why, optionally, like Resolve asks how. The review reads the operator's five latest reasons for each supervisor, quoted as theirs. Only the operator dismisses, so a reason never carries source data. |

### Known gaps

- Section history starts with the first briefing after this change, so the missing and unreadable signs need a few briefings before they can show.
- On a borderline sign, the same numbers led to a proposal in some runs and not others. A sign that still stands gets one more review a week later.
- The review judges from counts alone. It can't tell a useful finding from a noisy one except by what the operator did with it.
- A replacement starts with empty notes, and ending or replacing is refused while the supervisor has open questions or tasks; the operator approves again once they are done.
