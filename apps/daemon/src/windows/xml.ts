// Text that goes into XML Windows parses: toasts and Task Scheduler tasks. Both reject a document
// with a control character or a broken surrogate in it, so those are dropped rather than escaped.

const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|\p{Cs}/gu;

export function escapeXml(text: string): string {
  return text
    .replace(INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
