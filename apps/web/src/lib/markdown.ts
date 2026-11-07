// A small markdown parser for notes, briefings, and chat. Notes and messages can hold text from
// mail and calendars, so this never produces HTML: it builds a tree that `Markdown.tsx` turns into
// React elements, and React escapes every string. Raw HTML in the source stays literal text, and
// only http, https, and mailto links become links.
//
// Covers what staff notes use: headings, paragraphs, lists with checkboxes, quotes, code, rules,
// emphasis, inline code, links, and Obsidian [[wikilinks]] with #heading and |alias.

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "strike"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "wikilink"; target: string; heading: string | null; label: string }
  | { type: "break" };

export interface ListItem {
  /** Null for a plain item; true or false for a task. */
  checked: boolean | null;
  /** Indentation level, from 0. */
  depth: number;
  children: Inline[];
}

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "quote"; children: Block[] }
  | { type: "code"; lang: string; text: string }
  | { type: "rule" };

/** Schemes a link may use. Anything else, such as javascript: or data:, stays text. */
const SAFE_SCHEMES = /^(https?:|mailto:)/i;

export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  // Control characters and spaces can hide a scheme from the check.
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  return SAFE_SCHEMES.test(trimmed) ? trimmed : null;
}

/** Splits a wikilink's inside, such as "Anna Lindqvist#Notes|Anna", into its parts. */
export function parseWikilink(inner: string): { target: string; heading: string | null; alias: string | null } {
  const pipe = inner.indexOf("|");
  const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
  const ref = pipe === -1 ? inner : inner.slice(0, pipe);
  const hash = ref.indexOf("#");
  const heading = hash === -1 ? null : ref.slice(hash + 1).trim() || null;
  const target = (hash === -1 ? ref : ref.slice(0, hash)).trim();
  return { target, heading, alias };
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)\s*([\w+-]*)/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines, 0);
}

function parseBlocks(lines: string[], nesting: number): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(fence[1]!)) body.push(lines[index++]!);
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1]!.length, children: parseInline(heading[2]!) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    if (/^\s{0,3}>/.test(line) && nesting < 4) {
      flush();
      const quoted: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s{0,3}>\s?/, ""));
      index--;
      blocks.push({ type: "quote", children: parseBlocks(quoted, nesting + 1) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]!);
      const list: Block & { type: "list" } = { type: "list", ordered, start: ordered ? Number.parseInt(item[2]!, 10) : 1, items: [] };
      while (index < lines.length) {
        const match = LIST_ITEM.exec(lines[index]!);
        if (match) {
          const task = TASK.exec(match[3]!);
          list.items.push({
            checked: task ? task[1] !== " " : null,
            depth: Math.min(4, Math.floor(match[1]!.replace(/\t/g, "  ").length / 2)),
            children: parseInline(task ? task[2]! : match[3]!),
          });
        } else if (/^\s+\S/.test(lines[index]!) && list.items.length) {
          // A continuation line of the item above.
          const last = list.items.at(-1)!;
          last.children = [...last.children, { type: "break" }, ...parseInline(lines[index]!.trim())];
        } else break;
        index++;
      }
      index--;
      blocks.push(list);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Characters that can start something other than plain text. */
const SPECIAL = /[`[*_~\\\nh]/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const pushText = (value: string) => {
    plain += value;
  };
  const flush = () => {
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };

  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index]!;
    if (!SPECIAL.test(char)) {
      pushText(char);
      index++;
      continue;
    }

    if (char === "\\" && index + 1 < text.length && /[\\`*_[\]#~|>-]/.test(text[index + 1]!)) {
      pushText(text[index + 1]!);
      index += 2;
      continue;
    }
    if (char === "\n") {
      push({ type: "break" });
      index++;
      continue;
    }
    if (char === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = text.indexOf(ticks, index + ticks.length);
      if (end !== -1) {
        push({ type: "code", text: text.slice(index + ticks.length, end).trim() || text.slice(index + ticks.length, end) });
        index = end + ticks.length;
        continue;
      }
      pushText(ticks);
      index += ticks.length;
      continue;
    }
    if (rest.startsWith("[[")) {
      const end = text.indexOf("]]", index + 2);
      const inner = end === -1 ? "" : text.slice(index + 2, end);
      if (end !== -1 && inner.trim() && !inner.includes("\n") && !inner.includes("[")) {
        const { target, heading, alias } = parseWikilink(inner);
        if (target) {
          push({ type: "wikilink", target, heading, label: alias ?? (heading ? `${target} › ${heading}` : target) });
          index = end + 2;
          continue;
        }
      }
    }
    if (char === "[") {
      const link = /^\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\))?[^()\s]*)(?:\s+"[^"\n]*")?\)/.exec(rest);
      if (link) {
        const href = safeHref(link[2]!);
        const children = parseInline(link[1]!);
        if (href) push({ type: "link", href, children });
        else {
          // An unsafe link keeps its label and shows where it pointed, as text.
          flush();
          out.push(...children, { type: "text", text: ` (${link[2]!})` });
        }
        index += link[0].length;
        continue;
      }
    }
    if (char === "h") {
      const bare = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest);
      const before = index === 0 ? " " : text[index - 1]!;
      if (bare && /[\s(]/.test(before)) {
        push({ type: "link", href: bare[0], children: [{ type: "text", text: bare[0] }] });
        index += bare[0].length;
        continue;
      }
      pushText(char);
      index++;
      continue;
    }
    if (char === "~" && rest.startsWith("~~")) {
      const end = text.indexOf("~~", index + 2);
      if (end > index + 2) {
        push({ type: "strike", children: parseInline(text.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      const double = rest.startsWith(char + char);
      const marker = double ? char + char : char;
      const end = findClosing(text, index + marker.length, marker);
      // Intraword underscores, as in snake_case, stay text.
      const intraword = char === "_" && index > 0 && /\w/.test(text[index - 1]!);
      if (end !== -1 && !intraword) {
        const inner = parseInline(text.slice(index + marker.length, end));
        push(double ? { type: "strong", children: inner } : { type: "em", children: inner });
        index = end + marker.length;
        continue;
      }
      pushText(marker);
      index += marker.length;
      continue;
    }
    pushText(char);
    index++;
  }
  flush();
  return out;
}

/** The closing emphasis marker: not followed by whitespace before it, and with something inside. */
function findClosing(text: string, from: number, marker: string): number {
  if (from >= text.length || /\s/.test(text[from]!)) return -1;
  let index = text.indexOf(marker, from);
  while (index !== -1) {
    const single = marker.length === 1;
    const doubled = single && text[index + 1] === marker;
    if (index > from && !/\s/.test(text[index - 1]!) && !doubled) return index;
    if (doubled) index = text.indexOf(marker, index + 2);
    else index = text.indexOf(marker, index + 1);
  }
  return -1;
}

/** A whole document as one line of plain text, for a speech bubble or a preview. */
export function plainText(source: string): string {
  const blockText = (block: Block): string => {
    switch (block.type) {
      case "heading":
      case "paragraph":
        return inlineText(block.children);
      case "list":
        return block.items.map((item) => inlineText(item.children)).join("; ");
      case "quote":
        return block.children.map(blockText).join(" ");
      case "code":
        return block.text;
      case "rule":
        return "";
    }
  };
  return parseMarkdown(source)
    .map(blockText)
    .filter((text) => text.trim() !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The plain text of inline nodes, such as for a tooltip or a search. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        case "wikilink":
          return node.label;
        case "break":
          return " ";
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}
