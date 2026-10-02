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

import type { InviteCapabilityToken } from "../../lib/types";

export const INVITE_QR_MODAL_HELPER_COPY =
  "You can re-open this QR code or copy the airlock link at any time from your Invites table.";

export interface IssueInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  mintedToken?: InviteCapabilityToken | null;
  qrUrl?: string | null;
  inviteLink?: string | null;
  onCopyJson?: () => void;
  onCopyLink?: () => void;
  copiedJson?: boolean;
  copiedLink?: boolean;
}

/**
 * Presentation subcomponent for the issued invite QR code and credentials.
 */
export default function IssueInviteModal({
  isOpen,
  onClose,
  mintedToken,
  qrUrl,
  inviteLink,
  onCopyJson,
  onCopyLink,
  copiedJson = false,
  copiedLink = false,
}: IssueInviteModalProps) {
  if (!isOpen) return null;

  return (
    <div
      data-testid="issue-invite-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Issue invite"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#ffffff",
          color: "#0f172a",
          borderRadius: "12px",
          padding: "1.5rem",
          maxWidth: 520,
          width: "92%",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.85rem" }}>
          <span style={{ fontSize: "1.25rem" }}>{"\u2705"}</span>
          <h3 style={{ margin: 0, fontSize: "1.05rem" }}>Invite minted and signed</h3>
        </div>
        <p style={{ fontSize: "0.82rem", color: "#6b7280", marginTop: 0 }}>
          Share the link below (or scan the QR) with the person you are inviting.
        </p>

        {mintedToken && (
          <textarea
            data-testid="invite-token-json"
            readOnly
            value={JSON.stringify(mintedToken)}
            rows={7}
            style={{
              width: "100%",
              fontFamily: "monospace",
              fontSize: "0.68rem",
              padding: "0.5rem",
              borderRadius: "6px",
              border: "1px solid #d1d5db",
              background: "#f9fafb",
              boxSizing: "border-box",
            }}
          />
        )}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
          {onCopyJson && (
            <button type="button" onClick={onCopyJson} style={{ fontSize: "0.82rem" }}>
              {copiedJson ? "✓ Copied" : "Copy Token JSON"}
            </button>
          )}
          {inviteLink && onCopyLink && (
            <button type="button" onClick={onCopyLink} style={{ fontSize: "0.82rem" }}>
              {copiedLink ? "✓ Link Copied" : "Copy Invite Link"}
            </button>
          )}
        </div>

        {qrUrl && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.35rem", marginTop: "1rem" }}>
            <img
              data-testid="invite-qr-image"
              src={qrUrl}
              alt="Invite link QR code"
              style={{
                width: 180,
                height: 180,
                borderRadius: 8,
                background: "#ffffff",
                border: "1px solid #e5e7eb",
              }}
            />
            <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
              Scan to open invite link
            </span>
            <p
              data-testid="invite-qr-hint"
              style={{
                fontSize: "0.74rem",
                color: "#6b7280",
                margin: "0.35rem 0 0",
                textAlign: "center",
                maxWidth: 220,
              }}
            >
              {INVITE_QR_MODAL_HELPER_COPY}
            </p>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
          <button type="button" onClick={onClose} data-testid="invite-close-modal">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
