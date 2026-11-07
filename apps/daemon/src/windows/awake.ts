// Keeping the PC awake. Windows holds an ES_SYSTEM_REQUIRED request only while the thread that made
// it lives, and Node can't call Win32, so a small helper process makes the request and waits. It
// waits on its stdin, which closes when the daemon releases it or dies, so the helper can never
// outlive the daemon and hold the PC awake on its own.

/** Asks for ES_CONTINUOUS | ES_SYSTEM_REQUIRED, says "awake", and holds it until stdin closes. */
export const AWAKE_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -Namespace AiHubPower -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
  if ([AiHubPower.Native]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'SetThreadExecutionState refused the request' }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
[Console]::Out.WriteLine('awake')
[Console]::Out.Flush()
$null = [Console]::In.ReadToEnd()
`;
