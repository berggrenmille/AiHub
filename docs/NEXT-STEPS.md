# Next steps

Where the build stands against [DESIGN.md](../DESIGN.md) › Build sequence and acceptance.

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
- The briefing in the Chief of Staff chat is written from source data, and a later chat turn can write notes from it as `conversation`. Mark chat turns that follow a briefing as source data before chat runs more often (Milestone 5).
- The office has no note-removed event, so the UI drops a profile note's old path when a new one appears for the same owner. Unread chat counts live in the browser.

## Milestone 3: teams and delegation

Acceptance (DESIGN.md): a supervisor recruits a worker with narrowed access, reviews its result, and the worker leaves the office. A staff member asks a colleague a question without holding a turn open, and the answer arrives in a new turn.

1. **Assignments.** An assignment is a question or a task, with a requester, an owner, and either a parent assignment or the conversation it continues in, plus a brief, a run budget, a status, and a result. Runs record their assignment. Run kinds tell the gateway what a run is for: `question` and `assignment` for the owner's work, and `follow_up` when the requester resumes with results. When an assignment settles, the daemon starts the follow-up: a chat turn in the Chief of Staff's conversation, or a run on the parent assignment once all its children have settled.
2. **Asking and assigning.** `aihub_ask_colleague` (Chief of Staff and supervisors) turns a question into an assignment, and the asking turn ends. `aihub_assign_task` lets the Chief of Staff hand a supervisor bounded work within its role. A question run and a follow-up run get neither tool, so nothing nests or loops, and each run checks the daily turn budget first. The question and the answer cross as data, inside markers.
3. **Reading sources on demand.** `aihub_read_calendar` reads a window of a calendar the caller holds a grant for. Grants become the real boundary, so narrowing them means something.
4. **Workers.** `aihub_recruit_worker` (supervisors, in assignment runs) hires a worker with a profile, a task, and a subset of the supervisor's grants, within a cap per supervisor. The worker delivers. In its follow-up run the supervisor accepts each result or asks for one revision with `aihub_review_work`. On acceptance AiHub archives the worker and revokes its grants; its assignment, result, and notes stay.
5. **The office.** Workers walk in and out, a staff member asking a question walks to the colleague's desk, and a profile shows open and recent assignments.

### Progress (2026-11-07)

Steps 1 to 4 are in the daemon and checked against real Codex. Step 5, the office, is being built.

| Acceptance | Where it is shown |
| --- | --- |
| A staff member asks a colleague without holding a turn open, and the answer arrives in a new turn. | `staff/delegation.ts`, tested in `delegation.test.ts`. Against real Codex, Vera asked Nora when the standup series started. Her chat turn ended at "I've asked Nora", Nora answered in a `question` run, and Vera passed the answer on in a follow-up turn of the same thread (15,478 tokens in, 14,976 cached). |
| A supervisor recruits a worker with narrowed access, reviews its result, and the worker leaves the office. | Same files. Against real Codex, the operator asked for the recurring meetings that take the most time over two months. Vera assigned it to Nora, and Nora recruited Elias, Calendar Analyst, sharing only her Work calendar. Elias read both months and delivered. Nora re-read the calendar to check his tally and accepted it. Elias was archived with his grant revoked, and his profile note and his own note stayed in the vault. |
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
