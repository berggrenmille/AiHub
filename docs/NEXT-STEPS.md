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

## Milestone 2: staff, approvals, and one real source

Acceptance (DESIGN.md): a chat request produces a proposal, and approving it creates a supervisor, a responsibility, and a routine. One real local source feeds a briefing the operator reads daily. An unchanged item is not reported as new the next day, and a dismissed item stays out. Ending a mandate blocks further actions under it.

1. **Records.** Schema v3: responsibilities (with standing instructions, initiative policy, and an optional expiry, which makes a mandate), routines, proposals, connections, grants, cursors, and items.
2. **Proposals and approval cards.** A Chief of Staff tool proposes a supervisor with its charter, responsibility, routine, and requested access. The proposal shows as a card in the chat; approving it creates the agent, responsibility, and routine in one transaction. The caps on active supervisors and daily turns are checked in code, and a proposal that would exceed one says so.
3. **One real local source.** A local-file connection and a collector that reads it, normalizes records with stable IDs, and diffs against the cursor without a model turn. The first candidate is an `.ics` calendar export; a holdings CSV works the same way.
4. **Items.** Report items get a stable identity from their source record. Items are new, open, resolved, or dismissed; the compose step separates new items from carried-over ones, and a dismissed item stays out unless its source changes.
5. **Scheduler.** The weekday briefing routine in `Europe/Stockholm`, with occurrence IDs that deduplicate retries and restarts, and one catch-up after downtime.
6. **Mandates.** The gateway checks a responsibility's expiry before every call, so ending a mandate blocks further actions under it.
7. **UI.** Approval cards, the briefing with its items, and dismiss and resolve on each item.
