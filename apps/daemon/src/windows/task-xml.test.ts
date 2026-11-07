import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daemonAction, windowsNames } from "./names.ts";
import { commandLine, signInTaskXml, startBoundary, wakeTaskXml } from "./task-xml.ts";

const SID = "S-1-5-21-1-2-3-1001";
const action = daemonAction(
  { root: "C:\\My Projects\\AiHub", passOn: ["--port=7421", "--data-dir=C:\\Data & Co\\aihub"] },
  "C:\\Program Files\\nodejs\\node.exe",
  "C:\\WINDOWS",
);

describe("Windows command lines", () => {
  it("quotes only what needs it, the way Windows programs split arguments", () => {
    assert.equal(commandLine(["--headless", "C:\\Program Files\\nodejs\\node.exe", "src/index.ts"]), '--headless "C:\\Program Files\\nodejs\\node.exe" src/index.ts');
    assert.equal(commandLine(["", "a\"b", "C:\\dir with space\\"]), '"" "a\\"b" "C:\\dir with space\\\\"');
    // Backslashes before a quote are doubled; elsewhere they stay as they are.
    assert.equal(commandLine(['say \\"hi\\"']), '"say \\\\\\"hi\\\\\\""');
    assert.equal(commandLine(["C:\\plain\\path"]), "C:\\plain\\path");
  });

  it("runs the daemon in the background through a headless console host", () => {
    assert.equal(action.command, "C:\\WINDOWS\\System32\\conhost.exe");
    assert.deepEqual(action.args.slice(0, 2), ["--headless", "C:\\Program Files\\nodejs\\node.exe"]);
    assert.ok(action.args.includes("--background"));
    assert.deepEqual(action.args.slice(-2), ["--port=7421", "--data-dir=C:\\Data & Co\\aihub"]);
    assert.equal(action.workingDirectory, "C:\\My Projects\\AiHub\\apps\\daemon");
  });

  it("names everything from one word", () => {
    const names = windowsNames("AiHubTest");
    assert.equal(names.signInTask, "\\AiHubTest\\Start at sign-in");
    assert.equal(names.wakeTask, "\\AiHubTest\\Wake for briefing");
    assert.equal(names.appId, "AiHubTest.Office");
  });
});

describe("StartBoundary", () => {
  const at = new Date("2026-11-09T04:55:30.750Z");

  it("writes local time with its UTC offset, to the second", () => {
    assert.equal(startBoundary(at, 60), "2026-11-09T05:55:30+01:00");
    assert.equal(startBoundary(at, 0), "2026-11-09T04:55:30+00:00");
    assert.equal(startBoundary(at, -300), "2026-11-08T23:55:30-05:00");
    assert.equal(startBoundary(at, 330), "2026-11-09T10:25:30+05:30");
  });

  it("keeps the instant across a DST change", () => {
    // Stockholm leaves summer time on 25 October 2026 at 03:00 local time.
    assert.equal(startBoundary(new Date("2026-10-25T00:30:00Z"), 120), "2026-10-25T02:30:00+02:00");
    assert.equal(startBoundary(new Date("2026-10-25T01:30:00Z"), 60), "2026-10-25T02:30:00+01:00");
    for (const offset of [120, 60, -240, 0]) {
      assert.equal(new Date(startBoundary(at, offset)).getTime(), Date.parse("2026-11-09T04:55:30Z"));
    }
  });

  it("uses this computer's offset at that instant by default", () => {
    assert.equal(new Date(startBoundary(at)).getTime(), Date.parse("2026-11-09T04:55:30Z"));
  });
});

describe("task definitions", () => {
  it("starts the daemon at the operator's sign-in, without elevation or a time limit", () => {
    const xml = signInTaskXml({ userId: SID, description: "Starts AiHub <now> & later", action });
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
    assert.match(xml, new RegExp(`<LogonTrigger><Enabled>true</Enabled><UserId>${SID}</UserId></LogonTrigger>`));
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
    assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
    assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>3<\/Count><\/RestartOnFailure>/);
    assert.match(xml, /<WakeToRun>false<\/WakeToRun>/);
    assert.match(xml, /<Description>Starts AiHub &lt;now&gt; &amp; later<\/Description>/);
  });

  it("escapes the command line into the XML", () => {
    const xml = signInTaskXml({ userId: SID, description: "", action });
    assert.match(xml, /<Command>C:\\WINDOWS\\System32\\conhost\.exe<\/Command>/);
    assert.ok(
      xml.includes(
        "<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; --disable-warning=ExperimentalWarning --import tsx src/index.ts --background --port=7421 &quot;--data-dir=C:\\Data &amp; Co\\aihub&quot;</Arguments>",
      ),
    );
    assert.match(xml, /<WorkingDirectory>C:\\My Projects\\AiHub\\apps\\daemon<\/WorkingDirectory>/);
  });

  it("wakes the PC once, at a fixed instant, running the same command", () => {
    const at = new Date("2026-11-09T04:55:00Z");
    const xml = wakeTaskXml({ userId: SID, description: "Wake", action }, at);
    assert.ok(xml.includes(`<TimeTrigger><Enabled>true</Enabled><StartBoundary>${startBoundary(at)}</StartBoundary></TimeTrigger>`));
    assert.match(xml, /<WakeToRun>true<\/WakeToRun>/);
    assert.match(xml, /<StartWhenAvailable>false<\/StartWhenAvailable>/);
    assert.doesNotMatch(xml, /RestartOnFailure|LogonTrigger|Repetition/);
    const args = (xml: string) => /<Arguments>(.*)<\/Arguments>/.exec(xml)?.[1];
    assert.equal(args(xml), args(signInTaskXml({ userId: SID, description: "", action })));
  });
});
