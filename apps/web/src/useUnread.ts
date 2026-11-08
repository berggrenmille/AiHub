import { useEffect, useMemo, useState } from "react";
import type { ChatMessage, Conversation } from "@aihub/shared";
import { unreadCounts } from "./lib/chat.ts";

const keyOf = (conversationId: string) => `aihub.seen.${conversationId}`;

/**
 * Staff messages the operator hasn't seen, by chat, remembered in this browser. A chat this browser
 * hasn't come across before counts as read up to its newest message, so only what arrives later is
 * unread. The chat on screen is read as it fills.
 */
export function useUnread(conversations: Conversation[], messages: Record<string, ChatMessage[]>, visibleId: string | null): Map<string, number> {
  const [seen, setSeen] = useState<ReadonlyMap<string, number>>(() => new Map());

  useEffect(() => {
    const unknown = conversations.filter((conversation) => !seen.has(conversation.id));
    if (unknown.length === 0) return;
    setSeen((current) => {
      const next = new Map(current);
      for (const conversation of unknown) {
        const stored = readSeen(keyOf(conversation.id));
        const newest = stored ?? messages[conversation.id]?.at(-1)?.id ?? 0;
        if (stored === null) writeSeen(keyOf(conversation.id), newest);
        next.set(conversation.id, newest);
      }
      return next;
    });
  }, [conversations, messages, seen]);

  const newest = visibleId ? (messages[visibleId]?.at(-1)?.id ?? 0) : 0;
  useEffect(() => {
    if (!visibleId || (seen.get(visibleId) ?? -1) >= newest) return;
    writeSeen(keyOf(visibleId), newest);
    setSeen((current) => new Map(current).set(visibleId, newest));
  }, [visibleId, newest, seen]);

  return useMemo(
    () =>
      unreadCounts(
        conversations.filter((conversation) => seen.has(conversation.id)),
        messages,
        seen,
        visibleId,
      ),
    [conversations, messages, seen, visibleId],
  );
}

function readSeen(key: string): number | null {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : Number(value) || 0;
  } catch {
    return null;
  }
}

function writeSeen(key: string, id: number) {
  try {
    localStorage.setItem(key, String(id));
  } catch {
    // Unread counts reset with storage unavailable; nothing else depends on them.
  }
}
