# Connector probe

Answers the Milestone 6 questions before anything is built: can AiHub reach an outside account through Codex, from code and with no model turn, while staff runs never see it? (docs/NEXT-STEPS.md › Up next, DESIGN.md › Connectors and capabilities)

```bash
npm run spike:connectors            # both parts
npm run spike:connectors -- --mcp   # Part A only
npm run spike:connectors -- --apps  # Part B only
```

## Part A: MCP servers

Needs no sign-in and spends no usage. It runs:
- `test-service.ts`: a made-up mail service, an MCP server over HTTP behind its own OAuth server, with a work and a home mailbox and access tokens that last 15 seconds;
- `stdio-server.mjs`: a local MCP program.

Codex runs with a throwaway `CODEX_HOME` and the same locked-down features as AiHub's staff runs. Sign-ins go to a file in that home, so nothing lands in Windows' Credential Manager. The probe plays the operator's browser: it opens the sign-in address and follows the redirect back to Codex. It checks:
- a server given to one thread in its config, and whether other threads see it;
- signing in with `mcpServer/oauth/login`;
- calling tools from code with `mcpServer/tool/call`, including tools that change things or carry no labels;
- two accounts on one service;
- a token refresh after expiry, and a restart;
- when Codex starts a local program.

## Part B: ChatGPT apps

Uses AiHub's own `.codex-home` sign-in. It starts Codex with apps turned on and lists the apps and the tools a thread gets. It also checks that the locked-down features hide them. It calls no app unless asked:

```bash
npm run spike:connectors -- --apps --call-app=github.get_user_login '--args={"link_id":"link_…"}'
```

An app connected with more than one account wants the account's `link_id` as an argument. The tool's `_meta.link_accounts` lists them, and the probe prints their names. Pick a tool that reads public or harmless data.
