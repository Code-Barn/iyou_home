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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatActivityEvent, ChatPeerTarget, PeerContact } from "../../lib/types";
import { OmemoSession, type ChatTranscriptEntry } from "../../lib/omemoSession";
import { toRoutingHex } from "../../lib/omemoSession";
import { prettyShortId } from "../../lib/chatAddress";
import { XmppClient, type ChatInbound, type ChatSessionCredentials, type ChatStatus } from "../../lib/xmppClient";
import ChatHeader from "./chat/ChatHeader";
import MessageThread from "./chat/MessageThread";
import ChatComposer from "./chat/ChatComposer";
import OmemoTrustModal from "./chat/OmemoTrustModal";

interface PeerChatProps {
  contact: ChatPeerTarget | PeerContact;
  onBack?: () => void;
  onActivity?: (event: ChatActivityEvent) => void;
  /** Render as a full-height split-pane child instead of a standalone card. */
  fill?: boolean;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

const isPeerContact = (value: ChatPeerTarget | PeerContact): value is PeerContact =>
  typeof (value as PeerContact).display_name === "string" &&
  typeof (value as PeerContact).peer_id === "string" &&
  typeof (value as PeerContact).trust_level === "string";

const newId = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function PeerChat({ contact, onBack, onActivity, fill }: PeerChatProps) {
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [secure, setSecure] = useState<"untrusted" | "verified">("untrusted");
  const [showTrust, setShowTrust] = useState(false);
  const [messages, setMessages] = useState<ChatTranscriptEntry[]>([]);
  const [session, setSession] = useState<OmemoSession | null>(null);
  const [client] = useState(() => new XmppClient());

  const sessionRef = useRef<OmemoSession | null>(null);
  const ownJidRef = useRef("");
  const clientRef = useRef(client);
  clientRef.current = client;

  const target: ChatPeerTarget = isPeerContact(contact)
    ? { peerId: contact.peer_id, displayName: contact.display_name }
    : contact;
  const peerHex = target.peerHex ?? toRoutingHex(target.peerId);
  const peerJid = target.jid ?? (peerHex ? `${peerHex}@127.0.0.1` : "");
  const displayName = (target.displayName && target.displayName.trim()) || prettyShortId(target.peerId);

  const appendMessage = useCallback(
    (direction: "out" | "in", body: string, encrypted: boolean, sender: string) => {
      const timestamp = Date.now();
      const entry: ChatTranscriptEntry = {
        id: newId(),
        direction,
        body,
        encrypted,
        timestamp,
        sender,
      };
      setMessages((prev) => [...prev, entry]);
      onActivity?.({ peerJid, direction, body, encrypted, timestamp });
    },
    [peerJid, onActivity],
  );

  const handleInbound = useCallback(
    async (inbound: ChatInbound) => {
      const s = sessionRef.current;
      const ownJid = ownJidRef.current;
      if (!s || !ownJid) {
        return;
      }
      const senderBare = OmemoSession.parseBare(inbound.from);
      if (senderBare === ownJid) {
        // The loopback socket echoes our own optimistic send.
        return;
      }
      if (inbound.omemo) {
        try {
          const envelope = OmemoSession.parseEnvelope(inbound.omemo);
          const sealed = envelope.keys[0]?.payload;
          if (!sealed) {
            throw new Error("Envelope carries no key payload");
          }
          const body = await s.decryptText(sealed);
          appendMessage("in", body, true, truncate(senderBare, 20));
        } catch {
          appendMessage("in", "🔒 Sealed message could not be unsealed.", true, truncate(senderBare, 20));
        }
        return;
      }
      appendMessage("in", inbound.body, false, truncate(senderBare, 20));
    },
    [appendMessage],
  );

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (!peerJid) {
        setError("This peer address is not routable — it needs a 64-hex key, did:key, npub, or bare JID.");
        return;
      }
      try {
        const creds = await invoke<ChatSessionCredentials>(
          "get_chat_session_credentials",
        );
        if (cancelled) return;

        const chatSession = new OmemoSession(creds.jid, peerJid);
        sessionRef.current = chatSession;
        ownJidRef.current = creds.jid;
        setSession(chatSession);

        // Ensure the enclave OMEMO device exists and its bundle is published
        // under our own Level 1 JID before honoring inbound sealed messages.
        await chatSession.publishLocalBundle();
        await chatSession.initOmemo();
        if (cancelled) {
          return;
        }
        setSecure(chatSession.peerTrust);
        setError(null);

        const c = clientRef.current;
        c.setup(creds);
        c.onStatus(setStatus);
        c.onMessage((inbound) => void handleInbound(inbound));
        c.onError((message) => setError(message));
        c.connect();
      } catch (e) {
        if (!cancelled) {
          setError(typeof e === "string" ? e : String(e));
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
      clientRef.current.disconnect();
    };
  }, [peerJid, handleInbound]);

  const handleSend = useCallback(
    async (text: string) => {
      const s = sessionRef.current;
      const c = clientRef.current;
      if (!s || !c.isConnected) {
        setError("Connect to the enclave prosody before sending.");
        return;
      }
      try {
        const sealed = await s.encryptText(text);
        const envelopeXml = s.buildEnvelope(sealed);
        c.sendOmemoStanza(peerJid, envelopeXml);
        appendMessage("out", text, true, "you");
      } catch (e) {
        setError(typeof e === "string" ? e : String(e));
      }
    },
    [peerJid, appendMessage],
  );

  const handleVerify = useCallback(() => {
    const s = sessionRef.current;
    if (!s || !s.peerDevice) {
      return;
    }
    s.markPeerVerified(s.peerDevice.device_id);
    setSecure("verified");
    setShowTrust(false);
  }, []);

  const connected = status === "ready";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: fill ? "100%" : "min(68vh, 620px)",
        border: fill ? "none" : "1px solid #e5e7eb",
        borderRadius: fill ? 0 : "12px",
        overflow: "hidden",
        background: "white",
      }}
    >
      <ChatHeader
        displayName={displayName}
        peerKeyFingerprint={peerHex ? truncate(peerHex, 20) : truncate(peerJid, 20) || "unroutable"}
        connected={connected}
        secure={secure === "verified"}
        onBack={onBack}
        onShowTrust={() => setShowTrust(true)}
      />

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

      <MessageThread
        messages={messages}
        emptyText={`Start an OMEMO-sealed conversation with ${displayName}. Messages are sealed with the enclave envelope before leaving this machine.`}
      />

      <ChatComposer
        onSend={(text) => void handleSend(text)}
        disabled={!connected || !peerJid}
        placeholder={connected ? `Message ${displayName}…` : "Connecting to enclave prosody…"}
      />

      <OmemoTrustModal
        open={showTrust}
        peerName={displayName}
        peerDevice={session?.peerDevice ?? null}
        localDevice={session?.ownDevice ?? null}
        trustState={secure}
        fingerprintOf={(deviceInfo) =>
          sessionRef.current ? sessionRef.current.fingerprint(deviceInfo) : "unknown"
        }
        onVerify={handleVerify}
        onClose={() => setShowTrust(false)}
      />
    </div>
  );
}