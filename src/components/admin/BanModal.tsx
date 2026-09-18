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

/**
 * Ban & Enforce modal — RFC-003 one-click ban.
 *
 * Displays the target DID, collects the reason (preset + free text), scope,
 * expiry, invite-branch pruning, content purge and evidence hashes, then
 * fires `admin_ban`. The execution button is intentionally high-contrast:
 * banning is a one-click destructive moderation action.
 */

import { useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BanReport, MemberRecord } from "../../lib/types";

const REASON_PRESETS = ["Spam", "Harassment", "CSAM/Illegal", "Other"] as const;

const EXPIRY_OPTIONS = [
  { label: "Permanent", seconds: 0 },
  { label: "24 Hours", seconds: 24 * 3600 },
  { label: "7 Days", seconds: 7 * 24 * 3600 },
  { label: "30 Days", seconds: 30 * 24 * 3600 },
] as const;

const SCOPE_OPTIONS = ["node", "federated"] as const;

const BAN_BUTTON_STYLE: CSSProperties = {
  background: "#b91c1c",
  color: "#ffffff",
  border: "none",
  borderRadius: "8px",
  padding: "0.6rem 1.4rem",
  fontSize: "1rem",
  fontWeight: 800,
  cursor: "pointer",
  boxShadow: "0 4px 10px rgba(185,28,28,0.35)",
  letterSpacing: "0.02em",
};

export interface BanModalTarget {
  did: string;
}

interface BanModalProps {
  target: BanModalTarget | MemberRecord;
  onClose: () => void;
  /** Called after a successful ban so the parent can refresh panels. */
  onBanned?: (report: BanReport) => void;
}

function shortDid(did: string): string {
  return did.length > 26 ? `${did.slice(0, 12)}…${did.slice(-10)}` : did;
}

export default function BanModal({ target, onClose, onBanned }: BanModalProps) {
  const [preset, setPreset] = useState<string>("Spam");
  const [reason, setReason] = useState<string>("Spam");
  const [scope, setScope] = useState<string>("node");
  const [expiry, setExpiry] = useState<string>("Permanent");
  const [pruneBranch, setPruneBranch] = useState(true);
  const [purgeContent, setPurgeContent] = useState(true);
  const [evidence, setEvidence] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BanReport | null>(null);

  const applyPreset = (value: string) => {
    setPreset(value);
    setReason(value);
  };

  const handleBan = async () => {
    setSubmitting(true);
    setError(null);
    const reasonText = reason.trim() || (preset !== "Other" ? preset : "Unspecified");
    const expiresAt =
      EXPIRY_OPTIONS.find((o) => o.label === expiry)?.seconds ?? 0;
    const evidenceHashes = evidence
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
    try {
      const result = await invoke<BanReport>("admin_ban", {
        satelliteId: "",
        targetDid: target.did,
        reason: reasonText,
        scope,
        expiresAt: expiresAt === 0 ? null : Math.floor(Date.now() / 1000) + expiresAt,
        pruneBranch,
        purgeContent,
        evidenceHashes,
      });
      setReport(result);
      onBanned?.(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-testid="ban-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1200,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Ban identity"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          padding: "1.4rem",
          maxWidth: 500,
          width: "92%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
        }}
      >
        {report ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.7rem" }}>
              <span style={{ fontSize: "1.2rem" }}>{"\uD83D\uDEAB"}</span>
              <h3 style={{ margin: 0, fontSize: "1.05rem", color: "#0f172a" }}>
                Ban enforced
              </h3>
            </div>
            <p data-testid="ban-report-summary" style={{ fontSize: "0.85rem", color: "#374151", margin: "0 0 1rem" }}>
              Ban #{report.ban_id} for <b>{shortDid(report.did)}</b> —{" "}
              {report.severed_conns} conn(s) severed, {report.pruned_tokens} invite(s)
              pruned, {report.tombstones} event(s) tombstoned,{" "}
              {report.blobs_deleted} blob(s) purged, {report.events_broadcast} kind:1605
              broadcast(s).
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" data-testid="ban-done" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.05rem", color: "#0f172a" }}>
              {"\uD83D\uDEAB"} Ban identity
            </h3>
            <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0 0 1rem", wordBreak: "break-all" }}>
              Target DID: <code data-testid="ban-target-did" style={{ background: "#f3f4f6", padding: "0.1rem 0.4rem", borderRadius: 4 }}>{target.did}</code>
            </p>

            <label style={{ display: "block", marginBottom: "0.85rem", fontSize: "0.85rem", fontWeight: 600 }}>
              Reason preset
              <select
                data-testid="ban-reason-preset"
                value={preset}
                onChange={(e) => applyPreset(e.target.value)}
                style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
              >
                {REASON_PRESETS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "block", marginBottom: "0.85rem", fontSize: "0.85rem", fontWeight: 600 }}>
              Ban reason
              <input
                data-testid="ban-reason-text"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
              />
            </label>

            <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.85rem" }}>
              <label style={{ fontSize: "0.85rem", fontWeight: 600, flex: 1, minWidth: 140 }}>
                Scope
                <select
                  data-testid="ban-scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
                >
                  {SCOPE_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: "0.85rem", fontWeight: 600, flex: 1, minWidth: 140 }}>
                Expiry
                <select
                  data-testid="ban-expiry"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.label} value={o.label}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginBottom: "0.85rem", fontSize: "0.85rem" }}>
              <label style={{ fontWeight: 600 }}>
                <input
                  type="checkbox"
                  data-testid="ban-prune-branch"
                  checked={pruneBranch}
                  onChange={(e) => setPruneBranch(e.target.checked)}
                />{" "}
                Prune invite branch (revoke downline)
              </label>
              <label style={{ fontWeight: 600 }}>
                <input
                  type="checkbox"
                  data-testid="ban-purge-content"
                  checked={purgeContent}
                  onChange={(e) => setPurgeContent(e.target.checked)}
                />{" "}
                Purge content (tombstone events &amp; purge media)
              </label>
            </div>

            <label style={{ display: "block", marginBottom: "0.85rem", fontSize: "0.85rem", fontWeight: 600 }}>
              Evidence hashes (SHA-256, comma-separated, optional)
              <input
                data-testid="ban-evidence"
                type="text"
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder="a1b2…,c3d4…"
                style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.82rem", fontFamily: "monospace" }}
              />
            </label>

            {error && (
              <div
                data-testid="ban-error"
                style={{
                  padding: "0.5rem 0.8rem",
                  borderRadius: "6px",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#b91c1c",
                  fontSize: "0.8rem",
                  marginBottom: "0.85rem",
                  whiteSpace: "pre-wrap",
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "0.25rem" }}>
              <button type="button" data-testid="ban-cancel" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="ban-execute"
                onClick={handleBan}
                disabled={submitting}
                style={{ ...BAN_BUTTON_STYLE, opacity: submitting ? 0.6 : 1 }}
              >
                {submitting ? "\u23F3 Enforcing…" : "1-click Ban & Enforce \uD83D\uDEAB"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}