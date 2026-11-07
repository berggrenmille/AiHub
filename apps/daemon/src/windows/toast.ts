import { createHash } from "node:crypto";
import type { Notification } from "../platform.ts";
import { escapeXml } from "./xml.ts";

// Windows notifications ("toasts"). The toast APIs are WinRT, which Windows PowerShell 5.1 can call
// and PowerShell 7 can't, so each toast is one powershell.exe run. The script never changes; the
// toast arrives in environment variables, so no text is ever quoted into a command line.

const TITLE_LIMIT = 120;
const BODY_LIMIT = 500;
/** Windows rejects a longer tag. */
const TAG_LIMIT = 64;

/** Where a click leads: a path in the office, never another site. */
export function officeUrl(origin: string, path = "/"): string {
  try {
    const url = new URL(path, origin);
    if (url.origin === origin) return url.href;
  } catch {
    // A path that isn't a URL path opens the office itself.
  }
  return `${origin}/`;
}

/** The toast as Windows' XML. A click opens the office in the browser, by protocol activation. */
export function toastXml(notification: Notification, origin: string): string {
  const launch = officeUrl(origin, notification.path);
  return [
    `<toast activationType="protocol" launch="${escapeXml(launch)}">`,
    "<visual><binding template=\"ToastGeneric\">",
    `<text>${escapeXml(shorten(notification.title, TITLE_LIMIT))}</text>`,
    ...(notification.body.trim() ? [`<text>${escapeXml(shorten(notification.body, BODY_LIMIT))}</text>`] : []),
    "</binding></visual>",
    "</toast>",
  ].join("");
}

/** A tag Windows accepts; a long one is hashed, so two long tags still differ. */
export function toastTag(tag: string): string {
  return tag.length <= TAG_LIMIT ? tag : createHash("sha256").update(tag).digest("hex").slice(0, TAG_LIMIT);
}

function shorten(text: string, limit: number): string {
  const chars = [...text.trim()];
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit - 1).join("")}…`;
}

/** Shows the toast in AIHUB_TOAST_XML under the app id in AIHUB_TOAST_APP, replacing one with the same tag. */
export const TOAST_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($env:AIHUB_TOAST_XML)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  if ($env:AIHUB_TOAST_TAG) { $toast.Tag = $env:AIHUB_TOAST_TAG; $toast.Group = 'AiHub' }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:AIHUB_TOAST_APP).Show($toast)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
