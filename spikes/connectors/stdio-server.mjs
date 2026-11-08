// A local MCP server for the connector probe: a program Codex starts on this PC, speaking MCP over
// stdio. It notes each start in the file named by its first argument, so the probe can tell which
// threads made Codex start it.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.argv[2];
if (marker) appendFileSync(marker, `started ${process.pid}\n`);

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local-notes", version: "1.0.0" } } });
    case "tools/list":
      return send({
        id: message.id,
        result: { tools: [{ name: "count_notes", description: "Counts notes.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] },
      });
    case "tools/call":
      return send({ id: message.id, result: { content: [{ type: "text", text: "3 notes" }] } });
    case "ping":
      return send({ id: message.id, result: {} });
    default:
      return send({ id: message.id, error: { code: -32601, message: `No method ${message.method}` } });
  }
});
