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
 * Invite Capability Tokens — RFC-002 management panel.
 *
 * Surfaces issuer standing (role, rolling monthly quota, vetting milestones),
 * a minting modal (tier / max_uses / valid_days / satellite / scope), a
 * copyable + QR-encodable token handoff, and a revocable admission ledger.
 */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  InviteCapabilityToken,
  InviteRecord,
  InviteTier,
  IssuerStatus,
} from "../../lib/types";

const SCOPE_OPTIONS = ["relay:read", "relay:write"] as const;

const STATUS_STYLE: Record<InviteRecord["status"], CSSProperties> = {
  live: {
    background: "#ecfdf5",
    color: "#047857",
    border: "1px solid #a7f3d0",
  },
  used: {
    background: "#eff6ff",
    color: "#1d4ed8",
    border: "1px solid #bfdbfe",
  },
  revoked: {
    background: "#fef2f2",
    color: "#b91c1c",
    border: "1px solid #fecaca",
  },
  expired: {
    background: "#fffbeb",
    color: "#92400e",
    border: "1px solid #fde68a",
  },
};

const ROLE_LABEL: Record<InviteTier, string> = {
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

const ROLE_STYLE: Record<InviteTier, CSSProperties> = {
  admin: {
    background: "#312e81",
    color: "#ffffff",
  },
  member: {
    background: "#ecfdf5",
    color: "#047857",
    border: "1px solid #a7f3d0",
  },
  guest: {
    background: "#f3f4f6",
    color: "#374151",
    border: "1px solid #d1d5db",
  },
};

function formatDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString();
}

function shortNonce(nonce: string): string {
  return nonce.length > 12 ? `${nonce.slice(0, 6)}…${nonce.slice(-4)}` : nonce;
}

export default function InviteManager() {
  const [issuer, setIssuer] = useState<IssuerStatus | null>(null);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Minting modal state.
  const [showModal, setShowModal] = useState(false);
  const [tier, setTier] = useState<InviteTier>("member");
  const [maxUses, setMaxUses] = useState<number>(1);
  const [validDays, setValidDays] = useState<number>(30);
  const [satelliteId, setSatelliteId] = useState<string>("");
  const [extraScopes, setExtraScopes] = useState<string[]>([]);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mintedToken, setMintedToken] = useState<InviteCapabilityToken | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokingNonce, setRevokingNonce] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [status, records] = await Promise.all([
        invoke<IssuerStatus>("get_issuer_status"),
        invoke<InviteRecord[]>("list_invites"),
      ]);
      setIssuer(status);
      setInvites(records);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openModal = () => {
    setMintError(null);
    setMintedToken(null);
    setQrUrl(null);
    setCopied(false);
    // Members may only issue member-tier invites.
    setTier(issuer?.role === "admin" ? "member" : "member");
    setMaxUses(1);
    setValidDays(30);
    setSatelliteId("");
    setExtraScopes([]);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setMintedToken(null);
    setQrUrl(null);
  };

  const toggleScope = (scope: string) => {
    setExtraScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  const handleMint = async () => {
    setMinting(true);
    setMintError(null);
    try {
      const token = await invoke<InviteCapabilityToken>("create_invite_token", {
        tier,
        maxUses,
        validDays,
        scope: ["join", ...extraScopes],
        satelliteId: satelliteId.trim() || null,
      });
      setMintedToken(token);
      let qr: string | null = null;
      try {
        qr = await invoke<string>("render_invite_qr", { tokenJson: JSON.stringify(token) });
      } catch {
        // QR rendering is best-effort — the copyable JSON remains usable.
      }
      setQrUrl(qr);
      await refresh();
    } catch (err) {
      setMintError(String(err));
    } finally {
      setMinting(false);
    }
  };

  const handleRevoke = async (nonce: string) => {
    setRevokingNonce(nonce);
    try {
      await invoke("revoke_invite", { nonce });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setRevokingNonce(null);
    }
  };

  const handleCopy = async () => {
    if (!mintedToken) return;
    try {
      await writeText(JSON.stringify(mintedToken));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard plugin unavailable — fallback to navigator.
      try {
        await navigator.clipboard.writeText(JSON.stringify(mintedToken));
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      } catch {
        // no-op
      }
    }
  };

  const quotaLabel = (): string => {
    if (!issuer) return "…";
    if (issuer.role === "admin") return "Unlimited";
    return `${issuer.quota_used_last_30d} / ${issuer.quota_limit || 3} used`;
  };

  const vettingChips = () => {
    if (!issuer) return null;
    const v = issuer.vetting;
    const chips: { ok: boolean; label: string }[] = [
      { ok: v.account_age_ok, label: `Account ${v.account_age_days}d` },
      { ok: v.contacts_ok, label: `${v.contact_count} contacts` },
      { ok: v.flags_ok, label: "0 mod flags" },
    ];
    return chips.map((c) => (
      <span
        key={c.label}
        data-testid={`vetting-chip-${c.label.replace(/\s+/g, "-")}`}
        title={c.ok ? "Requirement met" : "Requirement not yet met"}
        style={{
          fontSize: "0.72rem",
          padding: "0.15rem 0.5rem",
          borderRadius: "999px",
          background: c.ok ? "#ecfdf5" : "#fffbeb",
          color: c.ok ? "#047857" : "#92400e",
          border: `1px solid ${c.ok ? "#a7f3d0" : "#fde68a"}`,
          fontWeight: 600,
        }}
      >
        {c.ok ? "✓" : "✗"} {c.label}
      </span>
    ));
  };

  return (
    <div data-testid="invite-manager">
      {/* Header + issuer standing */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.75rem",
          marginBottom: "1rem",
        }}
      >
        <div>
          <h3 style={{ fontSize: "1.05rem", fontWeight: 700, color: "#0f172a", margin: 0 }}>
            {"\uD83D\uDCE8"} Invite Capability Tokens
          </h3>
          <div
            style={{
              fontSize: "0.8rem",
              color: "#6b7280",
              marginTop: "0.25rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <span
              data-testid="invite-role"
              style={{
                ...ROLE_STYLE[issuer?.role ?? "member"],
                fontSize: "0.72rem",
                padding: "0.15rem 0.55rem",
                borderRadius: "999px",
                fontWeight: 700,
              }}
            >
              {ROLE_LABEL[issuer?.role ?? "member"]}
            </span>
            <span data-testid="invite-quota" title="Rolling 30-day issuance window">
              {"\uD83D\uDCC5"} {quotaLabel()}
            </span>
            {vettingChips()}
          </div>
        </div>
        <button type="button" onClick={openModal} data-testid="invite-issue-button">
          {"\u2709\uFE0F"} Issue Invite
        </button>
      </div>

      {error && (
        <div
          data-testid="invite-error"
          style={{
            padding: "0.6rem 0.9rem",
            borderRadius: "6px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            fontSize: "0.82rem",
            marginBottom: "0.75rem",
          }}
        >
          {error}
        </div>
      )}

      {/* Issued token ledger */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "2px solid #e5e7eb" }}>
              <th style={{ padding: "0.4rem 0.6rem" }}>Nonce</th>
              <th style={{ padding: "0.4rem 0.6rem" }}>Tier</th>
              <th style={{ padding: "0.4rem 0.6rem" }}>Status</th>
              <th style={{ padding: "0.4rem 0.6rem" }}>Recipient</th>
              <th style={{ padding: "0.4rem 0.6rem" }}>Uses</th>
              <th style={{ padding: "0.4rem 0.6rem" }}>Expires</th>
              <th style={{ padding: "0.4rem 0.6rem" }} />
            </tr>
          </thead>
          <tbody>
            {invites.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: "1rem 0.6rem", color: "#9ca3af" }}>
                  {loading ? "Loading invites…" : "No invites issued yet."}
                </td>
              </tr>
            )}
            {invites.map((inv) => (
              <tr key={inv.nonce} data-testid={`invite-row-${inv.nonce}`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: "0.5rem 0.6rem", fontFamily: "monospace", fontSize: "0.78rem" }}>
                  {shortNonce(inv.nonce)}
                </td>
                <td style={{ padding: "0.5rem 0.6rem" }}>{ROLE_LABEL[inv.tier] ?? inv.tier}</td>
                <td style={{ padding: "0.5rem 0.6rem" }}>
                  <span
                    data-testid={`invite-status-${inv.nonce}`}
                    style={{
                      ...STATUS_STYLE[inv.status],
                      fontSize: "0.72rem",
                      padding: "0.15rem 0.55rem",
                      borderRadius: "999px",
                      fontWeight: 600,
                      textTransform: "capitalize",
                    }}
                  >
                    {inv.status}
                  </span>
                </td>
                <td style={{ padding: "0.5rem 0.6rem", fontFamily: "monospace", fontSize: "0.75rem" }}>
                  {inv.child_did ? shortNonce(inv.child_did) : "—"}
                </td>
                <td style={{ padding: "0.5rem 0.6rem" }}>
                  {inv.uses_count} / {inv.max_uses}
                </td>
                <td style={{ padding: "0.5rem 0.6rem" }}>{formatDate(inv.expires_at)}</td>
                <td style={{ padding: "0.5rem 0.6rem", textAlign: "right" }}>
                  {inv.status !== "revoked" && (
                    <button
                      type="button"
                      data-testid={`invite-revoke-${inv.nonce}`}
                      onClick={() => handleRevoke(inv.nonce)}
                      disabled={revokingNonce === inv.nonce}
                      style={{ fontSize: "0.75rem", color: "#b91c1c", borderRadius: "6px", padding: "0.25rem 0.6rem" }}
                    >
                      {revokingNonce === inv.nonce ? "…" : "Revoke"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Minting modal */}
      {showModal && (
        <div
          data-testid="invite-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={closeModal}
        >
          <div
            role="dialog"
            aria-label="Issue invite"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              padding: "1.5rem",
              maxWidth: 520,
              width: "92%",
              maxHeight: "88vh",
              overflowY: "auto",
              boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
            }}
          >
            {mintedToken ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.85rem" }}>
                  <span style={{ fontSize: "1.25rem" }}>{"\u2705"}</span>
                  <h3 style={{ margin: 0, fontSize: "1.05rem", color: "#0f172a" }}>
                    Invite minted and signed
                  </h3>
                </div>
                <p style={{ fontSize: "0.82rem", color: "#6b7280", marginTop: 0 }}>
                  Share the token below (or scan the QR) with the person you are
                  inviting. The recipient scans/validates it against your DID.
                </p>
                <div
                  style={{
                    display: "flex",
                    gap: "1rem",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <textarea
                      data-testid="invite-token-json"
                      readOnly
                      value={JSON.stringify(mintedToken)}
                      rows={9}
                      style={{
                        width: "100%",
                        fontFamily: "monospace",
                        fontSize: "0.68rem",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        background: "#f9fafb",
                        color: "#0f172a",
                      }}
                    />
                    <button
                      type="button"
                      data-testid="invite-copy-json"
                      onClick={handleCopy}
                      style={{ marginTop: "0.5rem", fontSize: "0.82rem" }}
                    >
                      {copied ? "✓ Copied" : "Copy Token JSON"}
                    </button>
                  </div>
                  {qrUrl && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.35rem" }}>
                      <img
                        data-testid="invite-qr-image"
                        src={qrUrl}
                        alt="Invite token QR code"
                        style={{ width: 180, height: 180, borderRadius: 8, border: "1px solid #e5e7eb" }}
                      />
                      <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>Scan to invite</span>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
                  <button type="button" onClick={closeModal} data-testid="invite-close-modal">
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 style={{ margin: "0 0 0.25rem", fontSize: "1.05rem", color: "#0f172a" }}>
                  Issue Invite
                </h3>
                <p style={{ fontSize: "0.8rem", color: "#6b7280", margin: "0 0 1rem" }}>
                  Mint a signed capability token bound to your Level 1 identity.
                  {issuer?.role === "admin"
                    ? " As Admin you may issue any tier with no quota."
                    : " Members: ≤ 3 per rolling 30 days, member tier only."}
                </p>

                <label style={{ display: "block", marginBottom: "0.9rem", fontSize: "0.85rem", fontWeight: 600 }}>
                  Tier
                  <select
                    data-testid="invite-tier-select"
                    value={tier}
                    onChange={(e) => setTier(e.target.value as InviteTier)}
                    disabled={issuer?.role !== "admin"}
                    style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
                  >
                    {(issuer?.role === "admin" ? ["member", "admin", "guest"] : ["member"]).map((t) => (
                      <option key={t} value={t}>
                        {ROLE_LABEL[t as InviteTier]}
                      </option>
                    ))}
                  </select>
                </label>

                <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.9rem" }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600, flex: 1 }}>
                    Max uses (1–4)
                    <input
                      data-testid="invite-max-uses"
                      type="number"
                      min={1}
                      max={4}
                      value={maxUses}
                      onChange={(e) => setMaxUses(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                      style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
                    />
                  </label>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600, flex: 1 }}>
                    Valid days (1–90)
                    <input
                      data-testid="invite-valid-days"
                      type="number"
                      min={1}
                      max={90}
                      value={validDays}
                      onChange={(e) => setValidDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
                      style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
                    />
                  </label>
                </div>

                <label style={{ display: "block", marginBottom: "0.9rem", fontSize: "0.85rem", fontWeight: 600 }}>
                  Satellite (optional, empty = portable)
                  <input
                    data-testid="invite-satellite"
                    type="text"
                    value={satelliteId}
                    onChange={(e) => setSatelliteId(e.target.value)}
                    placeholder="sat.iyou.me"
                    style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
                  />
                </label>

                <div style={{ marginBottom: "0.9rem", fontSize: "0.85rem", fontWeight: 600 }}>
                  Scope
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.35rem" }}>
                    <label style={{ fontWeight: 500, fontSize: "0.82rem" }}>
                      <input type="checkbox" checked disabled /> join (required)
                    </label>
                    {SCOPE_OPTIONS.map((s) => (
                      <label key={s} style={{ fontWeight: 500, fontSize: "0.82rem" }}>
                        <input
                          type="checkbox"
                          data-testid={`invite-scope-${s}`}
                          checked={extraScopes.includes(s)}
                          onChange={() => toggleScope(s)}
                        />{" "}
                        {s}
                      </label>
                    ))}
                  </div>
                </div>

                {mintError && (
                  <div
                    data-testid="invite-mint-error"
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
                    {mintError}
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "0.25rem" }}>
                  <button type="button" onClick={closeModal} data-testid="invite-cancel-modal">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleMint}
                    disabled={minting}
                    data-testid="invite-submit"
                    style={{ opacity: minting ? 0.6 : 1 }}
                  >
                    {minting ? "\u23F3 Minting…" : "\u2709\uFE0F Mint & Sign"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}