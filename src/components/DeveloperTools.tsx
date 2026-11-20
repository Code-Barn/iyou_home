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

import { useState } from "react";
import type { Profile, ChatPeerTarget } from "../lib/types";
import SovereignSigner from "./SovereignSigner";
import PeerChat from "./enclave/PeerChat";

export interface DeveloperToolsProps {
  activeProfile?: Profile | null;
}

const DEFAULT_LOOPBACK_TARGET: ChatPeerTarget = {
  peerId: "127.0.0.1_loopback_test",
  displayName: "Local Diagnostic Peer (:5222)",
};

export default function DeveloperTools({ activeProfile }: DeveloperToolsProps = {}) {
  const [isHarnessOpen, setIsHarnessOpen] = useState(false);
  const [harnessPeerId, setHarnessPeerId] = useState(DEFAULT_LOOPBACK_TARGET.peerId);
  const [harnessDisplayName, setHarnessDisplayName] = useState(
    DEFAULT_LOOPBACK_TARGET.displayName ?? "Local Diagnostic Peer (:5222)",
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div>
        <h2 style={{ fontSize: "1.35rem", fontWeight: 700, margin: "0 0 0.5rem 0", color: "#0f172a" }}>
          Developer Tools
        </h2>
        <p style={{ fontSize: "0.88rem", color: "#64748b", margin: 0 }}>
          Internal enclave testing, raw challenge signing, and local protocol verification harnesses.
        </p>
      </div>

      {/* Sovereign Signer Panel */}
      <SovereignSigner activeProfile={activeProfile} />

      {/* Collapsible Local XMPP Loopback Harness Section */}
      <div
        style={{
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          background: "#ffffff",
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
        }}
      >
        <button
          type="button"
          onClick={() => setIsHarnessOpen((prev) => !prev)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.85rem 1.25rem",
            background: isHarnessOpen ? "#f8fafc" : "#ffffff",
            border: "none",
            borderBottom: isHarnessOpen ? "1px solid #e2e8f0" : "none",
            cursor: "pointer",
            textAlign: "left",
            fontSize: "0.95rem",
            fontWeight: 600,
            color: "#1e293b",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span>💬</span>
            <span>Local XMPP Loopback Harness (:5222)</span>
          </span>
          <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
            {isHarnessOpen ? "▲ Hide Harness" : "▼ Show Harness"}
          </span>
        </button>

        {isHarnessOpen && (
          <div style={{ padding: "1.25rem" }}>
            {/* Required Diagnostic Disclaimer */}
            <div
              style={{
                padding: "0.75rem 1rem",
                borderRadius: "6px",
                background: "#fef3c7",
                border: "1px solid #fde68a",
                color: "#92400e",
                fontSize: "0.85rem",
                lineHeight: 1.5,
                marginBottom: "1rem",
              }}
            >
              Diagnostic tool for testing raw local <code>127.0.0.1:5222</code> WebSocket routing.
              For production E2EE messaging, use <strong>iyou_chat</strong>.
            </div>

            {/* Test Target Configuration */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem",
                alignItems: "center",
                marginBottom: "1rem",
                padding: "0.75rem",
                background: "#f8fafc",
                borderRadius: "6px",
                border: "1px solid #e2e8f0",
              }}
            >
              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "#475569" }}>
                Target Peer ID:
                <input
                  type="text"
                  value={harnessPeerId}
                  onChange={(e) => setHarnessPeerId(e.target.value)}
                  style={{
                    marginLeft: "0.5rem",
                    padding: "0.3rem 0.5rem",
                    fontSize: "0.82rem",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    minWidth: "220px",
                  }}
                />
              </label>

              <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "#475569" }}>
                Display Name:
                <input
                  type="text"
                  value={harnessDisplayName}
                  onChange={(e) => setHarnessDisplayName(e.target.value)}
                  style={{
                    marginLeft: "0.5rem",
                    padding: "0.3rem 0.5rem",
                    fontSize: "0.82rem",
                    borderRadius: "4px",
                    border: "1px solid #cbd5e1",
                    minWidth: "180px",
                  }}
                />
              </label>
            </div>

            {/* Mounted PeerChat Diagnostic Harness */}
            <div
              style={{
                height: "500px",
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                overflow: "hidden",
                background: "#ffffff",
              }}
            >
              <PeerChat
                key={`${harnessPeerId}-${harnessDisplayName}`}
                contact={{
                  peerId: harnessPeerId,
                  displayName: harnessDisplayName,
                }}
                fill
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
