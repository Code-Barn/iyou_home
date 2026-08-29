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
import type { ChatPeerTarget } from "../../lib/types";
import { normalizePeerAddress, prettyShortId } from "../../lib/chatAddress";

interface NewChatModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (target: ChatPeerTarget) => void;
}

export default function NewChatModal({ open, onClose, onSubmit }: NewChatModalProps) {
  const [identifier, setIdentifier] = useState("");
  const [nickname, setNickname] = useState("");

  const result = useMemo(() => normalizePeerAddress(identifier), [identifier]);
  const valid = result.ok;

  if (!open) {
    return null;
  }

  const submit = () => {
    if (!valid) {
      return;
    }
    onSubmit({
      peerId: result.peerId,
      jid: result.peerJid,
      ...(result.peerHex ? { peerHex: result.peerHex } : {}),
      ...(nickname.trim() ? { displayName: nickname.trim() } : {}),
    });
    setIdentifier("");
    setNickname("");
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "520px" }}
      >
        <h3 style={{ marginTop: 0 }}>💬 Start a New Encrypted Chat</h3>

        <div className="form-group">
          <label>Peer identifier</label>
          <input
            type="text"
            autoFocus
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="did:key:z6Mk… · npub1… · 64-char hex · alice@iyou.me"
            style={{ fontFamily: "monospace", fontSize: "0.82rem" }}
          />
          <div
            style={{
              fontSize: "0.74rem",
              color: "#6b7280",
              marginTop: "0.35rem",
              lineHeight: 1.5,
            }}
          >
            Accepts an Ed25519 <code>did:key</code>, a Bech32 <code>npub1…</code>,
            a 64-character hex Nostr pubkey, or a bare JID. Routing is pinned to
            the native enclave prosody domain.
          </div>
          {identifier.trim() && (
            <>
              {valid ? (
                <div
                  style={{
                    marginTop: "0.5rem",
                    fontSize: "0.78rem",
                    background: "#e7f6ec",
                    color: "#137333",
                    border: "1px solid #b7dfc3",
                    borderRadius: "6px",
                    padding: "0.5rem 0.7rem",
                    fontFamily: "monospace",
                    wordBreak: "break-all",
                  }}
                >
                  Will route to <strong>{result.peerJid}</strong>
                </div>
              ) : (
                <div
                  style={{
                    marginTop: "0.5rem",
                    fontSize: "0.78rem",
                    background: "#fef2f2",
                    color: "#b91c1c",
                    border: "1px solid #fecaca",
                    borderRadius: "6px",
                    padding: "0.5rem 0.7rem",
                  }}
                >
                  {result.error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="form-group">
          <label>Nickname / petname (optional)</label>
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder='e.g. "Alice (Security Lead)"'
            style={{ fontSize: "0.9rem" }}
          />
          {valid && nickname.trim() && (
            <div
              style={{
                marginTop: "0.4rem",
                fontSize: "0.78rem",
                color: "#4b5563",
              }}
            >
              Identifies this peer as <strong>{nickname.trim()}</strong>{" "}
              {!valid || !result.peerHex ? (
                ""
              ) : (
                <span style={{ color: "#9ca3af" }}>
                  ({prettyShortId(result.peerHex)})
                </span>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            justifyContent: "flex-end",
            marginTop: "1.25rem",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "0.5rem 1rem",
              background: "#f3f4f6",
              color: "#374151",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!valid}
            style={{
              padding: "0.5rem 1.1rem",
              background: valid ? "#2563eb" : "#9ca3af",
              color: "white",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              cursor: valid ? "pointer" : "not-allowed",
            }}
          >
            Start Conversation
          </button>
        </div>
      </div>
    </div>
  );
}