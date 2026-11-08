import { useEffect, useRef, type ReactNode } from "react";

/**
 * A small panel that opens from a button, built on <details> so it works without script, and closes
 * on Escape or a click anywhere else.
 */
export function Popover({ className, summary, summaryClass, label, children }: { className?: string; summary: ReactNode; summaryClass: string; label?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const details = ref.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !details.contains(event.target as Node)) {
        details.open = false;
        if (event instanceof KeyboardEvent) details.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details ref={ref} className={`hud-popover${className ? ` ${className}` : ""}`}>
      <summary className={summaryClass} aria-label={label}>
        {summary}
      </summary>
      {children}
    </details>
  );
}
