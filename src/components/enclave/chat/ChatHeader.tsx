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

interface ChatHeaderProps {
  displayName: string;
  peerKeyFingerprint: string;
  connected: boolean;
  secure: boolean;
  onBack?: () => void;
  onShowTrust: () => void;
}

export default function ChatHeader({
  displayName,
  peerKeyFingerprint,
  connected,
  secure,
  onBack,
  onShowTrust,
}: ChatHeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.75rem 1rem",
        borderBottom: "1px solid #e5e7eb",
        background: "white",
      }}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          title="Back to conversation list"
          style={{
            padding: "0.35rem 0.6rem",
            fontSize: "0.85rem",
            background: "#f3f4f6",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            cursor: "pointer",
          }}
        >
          ←
        </button>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ fontSize: "0.95rem" }}>{displayName}</strong>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.75rem",
            color: connected ? "#137333" : "#6b7280",
            fontFamily: "monospace",
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: connected ? "#16a34a" : "#9ca3af",
              display: "inline-block",
            }}
          />
          {connected ? "Enclave prosody connected" : "Disconnected"}
          <span style={{ color: "#9ca3af" }}>
            {peerKeyFingerprint}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={onShowTrust}
        title="OMEMO fingerprint & trust"
        style={{
          padding: "0.35rem 0.7rem",
          fontSize: "0.78rem",
          background: secure ? "#e7f6ec" : "#fff7ed",
          color: secure ? "#137333" : "#9a3412",
          border: `1px solid ${secure ? "#b7dfc3" : "#fdba74"}`,
          borderRadius: "6px",
          cursor: "pointer",
        }}
      >
        {secure ? "🔒 Verified" : "🔓 Untrusted"}
      </button>
    </div>
  );
}