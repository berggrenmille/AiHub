import "./no-devtools.ts";
import { Component, useCallback, useMemo, useState, type ReactNode } from "react";
import { Renderer, type ActionEvent, type OpenUIError } from "@openuidev/react-lang";
import { DATA_TOOL_NAMES } from "@aihub/views";
import type { Item, View } from "@aihub/shared";
import { errorText } from "../api.ts";
import { siteOf, webUrl } from "../lib/views.ts";
import { viewRenderLibrary, ViewContext } from "./components.tsx";

// One view, drawn (DESIGN.md › Views). What its buttons do is decided here, not by the program: a
// message goes into a chat box for the operator to send or not, a page opens only if it is one, and
// an item is resolved or dismissed only if it exists. Whatever happens is said under the view.

export interface ViewActions {
  /** Puts a message in a chat box: the one the view is in, or its author's for a dashboard. */
  ask?(text: string): void;
  resolve(itemId: number, note?: string): Promise<void>;
  dismiss(itemId: number): Promise<void>;
  /** A dashboard's data. Views under messages fetch nothing. */
  data?(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

interface ViewFrameProps {
  view: View;
  items: Item[];
  actions: ViewActions;
  /** Where a message goes, such as "the chat box" or "Nora's chat". */
  askTarget?: string;
}

type Status = { text: string; tone: "ok" | "error" };

export function ViewFrame({ view, items, actions, askTarget = "the chat box" }: ViewFrameProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  // A new key draws the view afresh, fetching its data again.
  const [drawn, setDrawn] = useState(0);

  const fetchData = actions.data;
  const toolProvider = useMemo(
    () => (fetchData ? Object.fromEntries(DATA_TOOL_NAMES.map((name) => [name, (args: Record<string, unknown>) => fetchData(name, args ?? {})])) : null),
    [fetchData],
  );

  const onAction = useCallback(
    (event: ActionEvent) => {
      const params = event.params ?? {};
      const settle = (work: Promise<void>, done: string) =>
        work.then(
          () => setStatus({ text: done, tone: "ok" }),
          (failure: unknown) => setStatus({ text: errorText(failure), tone: "error" }),
        );
      switch (event.type) {
        case "continue_conversation": {
          const message = event.humanFriendlyMessage.trim();
          if (!message) return;
          if (!actions.ask) {
            setStatus({ text: "This chat is closed, so the message went nowhere.", tone: "error" });
            return;
          }
          actions.ask(message);
          setStatus({ text: `Put "${shorten(message)}" in ${askTarget}. Edit it, or press Enter there to send it.`, tone: "ok" });
          return;
        }
        case "open_url": {
          const url = webUrl(params.url);
          if (!url) {
            setStatus({ text: "That button's address isn't a web page, so nothing opened.", tone: "error" });
            return;
          }
          window.open(url.href, "_blank", "noopener,noreferrer");
          setStatus({ text: `Opened ${siteOf(url)} in a new tab.`, tone: "ok" });
          return;
        }
        case "ResolveItem":
        case "DismissItem": {
          const item = items.find((candidate) => candidate.id === params.id);
          if (!item) {
            setStatus({ text: `There is no item ${String(params.id)}, so nothing changed.`, tone: "error" });
            return;
          }
          if (item.state === "resolved" || item.state === "dismissed") {
            setStatus({ text: `"${item.title}" is already ${item.state}.`, tone: "ok" });
            return;
          }
          if (event.type === "ResolveItem") {
            const note = typeof params.note === "string" && params.note.trim() ? params.note.trim() : undefined;
            void settle(actions.resolve(item.id, note), `Resolved "${item.title}".`);
          } else {
            void settle(actions.dismiss(item.id), `Dismissed "${item.title}".`);
          }
          return;
        }
        default:
          setStatus({ text: "That button does nothing AiHub knows.", tone: "error" });
      }
    },
    [actions, items, askTarget],
  );

  const onError = useCallback((errors: OpenUIError[]) => {
    setProblems(errors.filter((error) => error.severity !== "warning").map((error) => (error.toolName ? `${error.toolName}: ${error.message}` : error.message)));
  }, []);

  return (
    <ViewContext.Provider value={{ outside: view.outside }}>
      <div className="view-frame">
        <ViewBoundary key={`${view.updatedAt}-${drawn}`}>
          <Renderer response={view.program} library={viewRenderLibrary} onAction={onAction} toolProvider={toolProvider} onError={onError} />
        </ViewBoundary>
        {problems.length > 0 && (
          <div className="view-problem" role="alert">
            <p>Part of this view couldn't be drawn: {problems.slice(0, 3).join(" · ")}</p>
            {fetchData && (
              <button type="button" className="link-button" onClick={() => setDrawn((count) => count + 1)}>
                Try again
              </button>
            )}
          </div>
        )}
        {status && (
          <p className={`view-status${status.tone === "error" ? " view-status-error" : ""}`} role="status">
            {status.text}
          </p>
        )}
      </div>
    </ViewContext.Provider>
  );
}

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** A view that throws while drawing is replaced by a note, never by a blank page. */
class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <p className="view-problem">This view couldn't be drawn.</p> : this.props.children;
  }
}
