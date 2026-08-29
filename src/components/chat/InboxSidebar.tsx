/*
 * Copyright (C) 2026 David Byers dba Byers Brands
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { ChatThread } from "../../lib/types";
import { prettyShortId } from "../../lib/chatAddress";
import { toRoutingHex } from "../../lib/omemoSession";

interface InboxSidebarProps {
  threads: ChatThread[];
  activeThreadJid: string | null;
  unreadTotal: number;
  onSelectThread: (jid: string) => void;
  onNewChat: () => void;
  /** Contact identifiers (hex or raw peer id) that exist in the Enclave. */
  knownPeers: ReadonlySet<string>;
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function snippetPreview(body: string): string {
  const single = body.replace(/\s+/g, " ").trim();
  return single.length > 52 ? `${single.slice(0, 52)}…` : single;
}

const AVATAR_COLORS = ["#312e81", "#065f46", "#7c3aed", "#9a3412", "#0f766e", "#b45309"];

export default function InboxSidebar({
  threads,
  activeThreadJid,
  unreadTotal,
  onSelectThread,
  onNewChat,
  knownPeers,
}: InboxSidebarProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(
      (t) =>
        t.displayName.toLowerCase().includes(q) ||
        t.peerJid.toLowerCase().includes(q) ||
        t.peerId.toLowerCase().includes(q),
    );
  }, [threads, query]);

  return (
    <div
      style={{
        width: "min(320px, 36%)",
        minWidth: 240,
        borderRight: "1px solid #e5e7eb",
        background: "#fafafa",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "0.75rem 1rem",
          borderBottom: "1px solid #e5e7eb",
          background: "white",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <strong style={{ fontSize: "0.95rem", flex: 1 }}>Conversations</strong>
        {unreadTotal > 0 && (
          <span
            style={{
              background: "#dc2626",
              color: "white",
              fontSize: "0.7rem",
              fontWeight: 700,
              borderRadius: "999px",
              padding: "0.1rem 0.5rem",
            }}
          >
            {unreadTotal} new
          </span>
        )}
        <button
          type="button"
          onClick={onNewChat}
          title="Start a new encrypted chat"
          style={{
            padding: "0.35rem 0.7rem",
            fontSize: "0.8rem",
            background: "#2563eb",
            color: "white",
            border: "none",
            borderRadius: "6px",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + New Chat
        </button>
      </div>

      <div style={{ padding: "0.75rem 1rem" }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats…"
          style={{
            width: "100%",
            padding: "0.45rem 0.7rem",
            borderRadius: "6px",
            border: "1px solid #d1d5db",
            fontSize: "0.82rem",
            boxSizing: "border-box",
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 0.5rem 0.5rem" }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: "2rem 1rem",
              textAlign: "center",
              color: "#9ca3af",
              fontSize: "0.82rem",
              lineHeight: 1.5,
            }}
          >
            {threads.length === 0
              ? "No conversations yet. Start a new encrypted chat to begin."
              : `No conversations match "${query}".`}
          </div>
        ) : (
          filtered.map((thread) => {
            const active = thread.peerJid === activeThreadJid;
            const inEnclave =
              knownPeers.has(thread.peerId) ||
              knownPeers.has(toRoutingHex(thread.peerId));
            const monogram = (thread.displayName || "?").trim().charAt(0).toUpperCase();
            const color = AVATAR_COLORS[
              Math.abs(thread.peerJid.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0)) %
                AVATAR_COLORS.length
            ];
            const rowStyle: CSSProperties = {
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              padding: "0.6rem 0.65rem",
              borderRadius: "8px",
              cursor: "pointer",
              border: "1px solid transparent",
              background: active ? "#eff6ff" : "transparent",
              borderColor: active ? "#bfdbfe" : "transparent",
            };
            return (
              <button
                key={thread.peerJid}
                type="button"
                onClick={() => onSelectThread(thread.peerJid)}
                style={{ ...rowStyle, width: "100%", textAlign: "left" }}
              >
                <div
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: "999px",
                    background: color,
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: "1rem",
                    flexShrink: 0,
                  }}
                >
                  {monogram}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                    <span
                      style={{
                        fontSize: "0.85rem",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        flex: 1,
                      }}
                    >
                      {thread.displayName}
                    </span>
                    {inEnclave && (
                      <span
                        style={{
                          fontSize: "0.62rem",
                          fontWeight: 700,
                          color: "#6d28d9",
                          background: "#ede9fe",
                          border: "1px solid #ddd6fe",
                          borderRadius: "999px",
                          padding: "0.05rem 0.4rem",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Enclave
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      marginTop: "0.15rem",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.74rem",
                        color: "#6b7280",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        flex: 1,
                      }}
                    >
                      {thread.lastMessageSnippet
                        ? snippetPreview(thread.lastMessageSnippet)
                        : prettyShortId(thread.peerJid, 8, 4)}
                    </span>
                    {thread.lastTimestamp > 0 && (
                      <span
                        style={{
                          fontSize: "0.68rem",
                          color: "#9ca3af",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatRelativeTime(thread.lastTimestamp)}
                      </span>
                    )}
                  </div>
                </div>
                {thread.unreadCount > 0 && (
                  <span
                    style={{
                      background: "#dc2626",
                      color: "white",
                      fontSize: "0.68rem",
                      fontWeight: 700,
                      borderRadius: "999px",
                      minWidth: 18,
                      height: 18,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "0 0.35rem",
                      flexShrink: 0,
                    }}
                  >
                    {thread.unreadCount}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}