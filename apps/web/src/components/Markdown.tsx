import { useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown.ts";

// Renders markdown as React elements. Every string goes through React, which escapes it, so text
// from notes, mail, or calendars can never become markup. No HTML strings anywhere.

export interface WikilinkTarget {
  /** True when the link points at a note that exists. */
  exists: boolean;
  /** A tooltip, such as the note's path. */
  title?: string;
}

interface MarkdownProps {
  source: string;
  className?: string;
  /** How a [[wikilink]] resolves. Without it, wikilinks render as plain labels. */
  resolveLink?(target: string): WikilinkTarget;
  onOpenLink?(target: string, heading: string | null): void;
}

export function Markdown({ source, className, resolveLink, onOpenLink }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const context: RenderContext = { resolveLink, onOpenLink };
  return <div className={`markdown${className ? ` ${className}` : ""}`}>{blocks.map((block, index) => renderBlock(block, index, context))}</div>;
}

interface RenderContext {
  resolveLink?: MarkdownProps["resolveLink"];
  onOpenLink?: MarkdownProps["onOpenLink"];
}

function renderBlock(block: Block, key: number, context: RenderContext): ReactNode {
  switch (block.type) {
    case "heading": {
      // Headings inside a note sit below the note's own title.
      const Tag = (`h${Math.min(6, block.level + 1)}` as "h2" | "h3" | "h4" | "h5" | "h6");
      return <Tag key={key}>{renderInlines(block.children, context)}</Tag>;
    }
    case "paragraph":
      return <p key={key}>{renderInlines(block.children, context)}</p>;
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} className={item.checked !== null ? "task" : undefined} style={item.depth ? { marginLeft: `${item.depth * 1.25}em` } : undefined}>
          {item.checked !== null && (
            <span className={`task-box${item.checked ? " checked" : ""}`} role="img" aria-label={item.checked ? "Done" : "Not done"} />
          )}
          {renderInlines(item.children, context)}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "quote":
      return <blockquote key={key}>{block.children.map((child, index) => renderBlock(child, index, context))}</blockquote>;
    case "code":
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      return <hr key={key} />;
  }
}

function renderInlines(nodes: Inline[], context: RenderContext): ReactNode[] {
  return nodes.map((node, index) => renderInline(node, index, context));
}

function renderInline(node: Inline, key: number, context: RenderContext): ReactNode {
  switch (node.type) {
    case "text":
      return node.text;
    case "strong":
      return <strong key={key}>{renderInlines(node.children, context)}</strong>;
    case "em":
      return <em key={key}>{renderInlines(node.children, context)}</em>;
    case "strike":
      return <s key={key}>{renderInlines(node.children, context)}</s>;
    case "code":
      return <code key={key}>{node.text}</code>;
    case "break":
      return <br key={key} />;
    case "link":
      return (
        <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
          {renderInlines(node.children, context)}
        </a>
      );
    case "wikilink": {
      const target = context.resolveLink?.(node.target);
      if (!target || !context.onOpenLink) {
        return (
          <span key={key} className="wikilink wikilink-plain">
            {node.label}
          </span>
        );
      }
      if (!target.exists) {
        return (
          <span key={key} className="wikilink wikilink-missing" title={`No note called “${node.target}” yet`}>
            {node.label}
          </span>
        );
      }
      return (
        <button key={key} type="button" className="wikilink" title={target.title} onClick={() => context.onOpenLink!(node.target, node.heading)}>
          {node.label}
        </button>
      );
    }
  }
}
