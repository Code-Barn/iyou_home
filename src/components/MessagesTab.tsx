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

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatActivityEvent, ChatPeerTarget, ChatThread, PeerContact } from "../lib/types";
import { toRoutingHex } from "../lib/omemoSession";
import { prettyShortId, targetFromPeerId } from "../lib/chatAddress";
import PeerChat from "./enclave/PeerChat";
import InboxSidebar from "./chat/InboxSidebar";
import NewChatModal from "./chat/NewChatModal";

const THREADS_STORAGE_KEY = "iyou_home_threads";

interface MessagesTabProps {
  initialPeer: ChatPeerTarget | null;
  onClearInitialPeer: () => void;
}

function sanitizeThreads(raw: unknown): ChatThread[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatThread[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Partial<ChatThread>;
    if (typeof t.peerJid !== "string" || t.peerJid.trim() === "") continue;
    out.push({
      peerJid: t.peerJid,
      peerId: typeof t.peerId === "string" && t.peerId ? t.peerId : t.peerJid,
      displayName:
        typeof t.displayName === "string" && t.displayName.trim()
          ? t.displayName
          : prettyShortId(t.peerJid, 8, 4),
      lastMessageSnippet:
        typeof t.lastMessageSnippet === "string" ? t.lastMessageSnippet : "",
      lastTimestamp:
        typeof t.lastTimestamp === "number" && Number.isFinite(t.lastTimestamp)
          ? t.lastTimestamp
          : 0,
      unreadCount:
        typeof t.unreadCount === "number" && Number.isFinite(t.unreadCount)
          ? Math.max(0, Math.floor(t.unreadCount))
          : 0,
    });
  }
  return out;
}

function loadThreads(): ChatThread[] {
  try {
    return sanitizeThreads(JSON.parse(localStorage.getItem(THREADS_STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function makeSnippet(body: string): string {
  const single = body.replace(/\s+/g, " ").trim();
  return single.length > 60 ? `${single.slice(0, 60)}…` : single;
}

export default function MessagesTab({ initialPeer, onClearInitialPeer }: MessagesTabProps) {
  const [threads, setThreads] = useState<ChatThread[]>(loadThreads);
  const [activeThreadJid, setActiveThreadJid] = useState<string | null>(null);
  const [isNewChatOpen, setIsNewChatOpen] = useState(false);
  const [contactsByRaw, setContactsByRaw] = useState<Map<string, PeerContact>>(new Map());
  const [contactsByHex, setContactsByHex] = useState<Map<string, PeerContact>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Enclave contact index for trust badges + petname resolution.
  useEffect(() => {
    let cancelled = false;
    invoke<PeerContact[] | null>("list_contacts")
      .then((list) => {
        if (cancelled) return;
        const arr = Array.isArray(list) ? list : [];
        const byRaw = new Map<string, PeerContact>();
        const byHex = new Map<string, PeerContact>();
        for (const contact of arr) {
          byRaw.set(contact.peer_id, contact);
          const hex = toRoutingHex(contact.peer_id);
          if (hex) byHex.set(hex, contact);
        }
        setContactsByRaw(byRaw);
        setContactsByHex(byHex);
      })
      .catch((e) => {
        if (!cancelled) setError(typeof e === "string" ? e : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist thread metadata across restarts.
  useEffect(() => {
    try {
      localStorage.setItem(THREADS_STORAGE_KEY, JSON.stringify(threads));
    } catch {
      // localStorage unavailable — thread state stays in memory.
    }
  }, [threads]);

  const ensureThread = useCallback(
    (target: ChatPeerTarget) => {
      const hex = target.peerHex ?? toRoutingHex(target.peerId);
      const jid = target.jid ?? (hex ? `${hex}@127.0.0.1` : "");
      if (!jid) {
        return;
      }
      const known = contactsByRaw.get(target.peerId) ?? (hex ? contactsByHex.get(hex) : undefined);
      const now = Date.now();
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.peerJid === jid);
        if (idx >= 0) {
          const existing = prev[idx];
          const updated = {
            ...existing,
            displayName: target.displayName?.trim() || existing.displayName,
            lastTimestamp: now,
          };
          const next = [...prev];
          next.splice(idx, 1);
          return [updated, ...next];
        }
        const displayName =
          target.displayName?.trim() ||
          known?.display_name ||
          prettyShortId(hex || jid, 8, 6);
        const thread: ChatThread = {
          peerJid: jid,
          peerId: target.peerId,
          displayName,
          lastMessageSnippet: "",
          lastTimestamp: now,
          unreadCount: 0,
        };
        return [thread, ...prev];
      });
      setActiveThreadJid(jid);
    },
    [contactsByRaw, contactsByHex],
  );

  // Handoff from Enclave contact rows or other tabs.
  useEffect(() => {
    if (!initialPeer) return;
    const resolved = initialPeer.jid
      ? initialPeer
      : targetFromPeerId(initialPeer.peerId, initialPeer.displayName);
    if (resolved.jid ?? toRoutingHex(resolved.peerId)) {
      ensureThread(resolved);
    }
    onClearInitialPeer();
  }, [initialPeer, ensureThread, onClearInitialPeer]);

  const handleActivity = useCallback(
    (event: ChatActivityEvent) => {
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.peerJid === event.peerJid);
        if (idx === -1) return prev;
        const thread = prev[idx];
        const inbound = event.direction === "in";
        const updated: ChatThread = {
          ...thread,
          lastMessageSnippet: makeSnippet(event.body),
          lastTimestamp: event.timestamp,
          unreadCount:
            inbound && event.peerJid !== activeThreadJid ? thread.unreadCount + 1 : 0,
        };
        const next = [...prev];
        next.splice(idx, 1);
        return [updated, ...next];
      });
    },
    [activeThreadJid],
  );

  const handleSelectThread = useCallback(
    (jid: string) => {
      if (jid === activeThreadJid) {
        setActiveThreadJid(null);
        return;
      }
      setActiveThreadJid(jid);
      setThreads((prev) =>
        prev.map((t) => (t.peerJid === jid ? { ...t, unreadCount: 0 } : t)),
      );
    },
    [activeThreadJid],
  );

  const unreadTotal = useMemo(
    () => threads.reduce((acc, t) => acc + t.unreadCount, 0),
    [threads],
  );

  const knownPeers = useMemo(() => {
    const set = new Set<string>();
    for (const contact of contactsByRaw.values()) {
      set.add(contact.peer_id);
      const hex = toRoutingHex(contact.peer_id);
      if (hex) set.add(hex);
    }
    return set;
  }, [contactsByRaw]);

  const activeThread = useMemo(
    () => threads.find((t) => t.peerJid === activeThreadJid) ?? null,
    [threads, activeThreadJid],
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          height: "min(70vh, 640px)",
          border: "1px solid #e5e7eb",
          borderRadius: "12px",
          overflow: "hidden",
          background: "white",
        }}
      >
        <InboxSidebar
          threads={threads}
          activeThreadJid={activeThreadJid}
          unreadTotal={unreadTotal}
          onSelectThread={handleSelectThread}
          onNewChat={() => setIsNewChatOpen(true)}
          knownPeers={knownPeers}
        />
        <div style={{ flex: 1, minWidth: 0, background: "white" }}>
          {error && (
            <div
              style={{
                padding: "0.5rem 1rem",
                fontSize: "0.78rem",
                color: "#dc2626",
                background: "#fef2f2",
                borderBottom: "1px solid #fecaca",
              }}
            >
              {error}
            </div>
          )}
          {activeThread ? (
            <PeerChat
              key={activeThread.peerJid}
              fill
              contact={{
                peerId: activeThread.peerId,
                displayName: activeThread.displayName,
                jid: activeThread.peerJid,
                peerHex: toRoutingHex(activeThread.peerId) || undefined,
              }}
              onBack={() => setActiveThreadJid(null)}
              onActivity={handleActivity}
            />
          ) : (
            <div
              style={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.75rem",
                textAlign: "center",
                padding: "2rem",
                color: "#6b7280",
              }}
            >
              <span style={{ fontSize: "2.5rem" }}>💬</span>
              <div style={{ fontSize: "0.92rem", fontWeight: 600, color: "#374151" }}>
                Select a conversation or start a new encrypted chat
              </div>
              <div style={{ fontSize: "0.8rem", maxWidth: "26rem", lineHeight: 1.6 }}>
                Every message is sealed with the native enclave OMEMO envelope
                before it leaves this machine.
              </div>
              <button
                type="button"
                onClick={() => setIsNewChatOpen(true)}
                style={{
                  marginTop: "0.5rem",
                  padding: "0.55rem 1.1rem",
                  background: "#2563eb",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontWeight: 600,
                  fontSize: "0.9rem",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                + Start New Chat
              </button>
            </div>
          )}
        </div>
      </div>

      <NewChatModal
        open={isNewChatOpen}
        onClose={() => setIsNewChatOpen(false)}
        onSubmit={(target) => {
          ensureThread(target);
          setIsNewChatOpen(false);
        }}
      />
    </div>
  );
}