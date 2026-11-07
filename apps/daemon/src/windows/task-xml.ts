import { escapeXml } from "./xml.ts";

// Task Scheduler definitions for AiHub's two tasks (DESIGN.md › Windows lifecycle): one starts the
// daemon at sign-in, the other wakes the PC shortly before a briefing. Both run the same command, so
// whichever fires first starts the daemon and a second copy finds it running and exits. They run as
// the operator, only while signed in, without elevation, which is what lets a normal user register
// them.

export interface TaskAction {
  command: string;
  args: string[];
  workingDirectory: string;
}

export interface TaskDefinition {
  /** The operator's SID: the task runs as them, and only while they're signed in. */
  userId: string;
  description: string;
  action: TaskAction;
}

/** Quotes arguments the way Windows programs split them (CommandLineToArgvW and the C runtime). */
export function commandLine(args: string[]): string {
  return args.map(quoteArgument).join(" ");
}

function quoteArgument(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    // Backslashes count only before a quote: double them there, and escape the quote itself.
    quoted += char === '"' ? "\\".repeat(backslashes * 2 + 1) + char : "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/**
 * The instant as Task Scheduler's StartBoundary, in local time with its UTC offset, such as
 * "2026-11-09T05:55:00+01:00". With an offset the trigger is a fixed instant: a time zone or DST
 * change before it fires doesn't move it. Seconds are the finest Task Scheduler keeps.
 */
export function startBoundary(at: Date, offsetMinutes = -at.getTimezoneOffset()): string {
  const local = new Date(Math.floor(at.getTime() / 1000) * 1000 + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(offsetMinutes);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Starts the daemon when the operator signs in, and again if it fails to start. */
export function signInTaskXml(task: TaskDefinition): string {
  return taskXml(task, {
    trigger: `<LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(task.userId)}</UserId></LogonTrigger>`,
    wake: false,
    // Task Scheduler only counts a launch that fails as a failure, so this covers a start that
    // races sign-in, not a daemon that exits with an error.
    restart: "<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>",
  });
}

/** Wakes the PC at one instant and makes sure the daemon is running. */
export function wakeTaskXml(task: TaskDefinition, at: Date): string {
  return taskXml(task, {
    trigger: `<TimeTrigger><Enabled>true</Enabled><StartBoundary>${startBoundary(at)}</StartBoundary></TimeTrigger>`,
    wake: true,
    restart: "",
  });
}

function taskXml(task: TaskDefinition, parts: { trigger: string; wake: boolean; restart: string }): string {
  const { action } = task;
  // The daemon is the task's process, so it must never time out, stop on battery, or stop when the
  // PC stops being idle. A missed time trigger is not run late: by then the sign-in task has started
  // the daemon, or the PC was off and the briefing catches up when it's back.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>AiHub</Author>
    <Description>${escapeXml(task.description)}</Description>
  </RegistrationInfo>
  <Triggers>
    ${parts.trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(task.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>${parts.wake}</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>${parts.restart ? `\n    ${parts.restart}` : ""}
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(action.command)}</Command>
      <Arguments>${escapeXml(commandLine(action.args))}</Arguments>
      <WorkingDirectory>${escapeXml(action.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}
