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
 *
 * The mutual-contact anti-Sybil gate is waived for the vault's Genesis /
 * Operator identity and for Admin issuers (see `inviteVetting.ts`); ordinary
 * members remain subject to the operator-tunable contact threshold.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  InviteCapabilityToken,
  InviteQrPayload,
  InviteRecord,
  InviteTier,
  IssuerStatus,
} from "../../lib/types";
import {
  MAX_CONTACTS_CEILING,
  MIN_CONTACTS_FLOOR,
  clampThreshold,
  deriveInviteStanding,
  maxUsesLimit,
} from "./inviteVetting";

const SCOPE_OPTIONS = ["relay:read", "relay:write"] as const;

/**
 * True in a `vite dev` build. Read at render time (not cached at module scope)
 * so tests can stub `import.meta.env.DEV`. The enclave remains the enforcing
 * authority regardless — this only waives the *displayed* gate.
 */
const isDevMode = (): boolean => Boolean(import.meta.env?.DEV);

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

/** Genesis / Operator badge — the root network identity. */
const GENESIS_STYLE: CSSProperties = {
  background: "#4c1d95",
  color: "#ffffff",
  border: "1px solid #ddd6fe",
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
  // Airlock deep link (`https://iyou.me/airlock/?invite=…`) — built by the
  // enclave alongside the QR so the two can never encode different tokens.
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const [revokingNonce, setRevokingNonce] = useState<string | null>(null);

  // Genesis / Admin bypass state.
  const [contacts, setContacts] = useState<{ peer_id: string }[]>([]);
  const [thresholdDraft, setThresholdDraft] = useState<number | null>(null);
  const [thresholdSaved, setThresholdSaved] = useState<number | null>(null);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [savingThreshold, setSavingThreshold] = useState(false);

  const contactCount = contacts.length;
  const threshold = clampThreshold(issuer?.vetting?.min_contacts_required ?? 5);

  const standing = useMemo(
    () => deriveInviteStanding({ issuer, devMode: isDevMode(), contactCount }),
    [issuer, contactCount],
  );

  // `max_uses` ceiling: 4 for ordinary peers, 100 for Genesis / Operator.
  const maxUsesLimitValue = useMemo(() => maxUsesLimit(standing, issuer), [standing, issuer]);

  // Clamp a draft `max_uses` into the current ceiling. Applied on read so a
  // standing change (e.g. rotating away from Genesis) can never leave a
  // stale over-limit value in the input.
  const effectiveMaxUses = Math.min(maxUsesLimitValue, Math.max(1, maxUses));

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [status, records, contactList] = await Promise.all([
        invoke<IssuerStatus>("get_issuer_status"),
        invoke<InviteRecord[]>("list_invites"),
        // Best-effort: drives the "root identity with an empty contact book"
        // bootstrap case. The enclave also computes this server-side.
        invoke<{ peer_id: string }[]>("list_contacts").catch(() => []),
      ]);
      setIssuer(status);
      setInvites(records);
      setContacts(contactList ?? []);
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
    setInviteLink(null);
    setCopied(false);
    setCopiedLink(false);
    setThresholdError(null);
    // Members may only issue member-tier invites.
    setTier(issuer?.role === "admin" ? "member" : "member");
    setMaxUses(1);
    setValidDays(30);
    setSatelliteId("");
    setExtraScopes([]);
    setThresholdDraft(null);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setMintedToken(null);
    setQrUrl(null);
    setInviteLink(null);
    setCopiedLink(false);
  };

  /**
   * Persist the operator-tunable mutual-contact threshold. The enclave clamps
   * the value into [1, 50] and is the enforcing authority — this control tunes
   * the gate, it can never switch it off for ordinary members.
   */
  const handleSaveThreshold = async () => {
    if (thresholdDraft === null) return;
    setSavingThreshold(true);
    setThresholdError(null);
    try {
      const applied = await invoke<number>("set_vetting_threshold", {
        minContacts: thresholdDraft,
      });
      setThresholdSaved(applied);
      setThresholdDraft(null);
      await refresh();
    } catch (err) {
      setThresholdError(String(err));
    } finally {
      setSavingThreshold(false);
    }
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
        maxUses: effectiveMaxUses,
        validDays,
        scope: ["join", ...extraScopes],
        satelliteId: satelliteId.trim() || null,
      });
      setMintedToken(token);
      // The enclave builds the airlock deep link and the QR from this same
      // token JSON, so the copyable link and the scanned code cannot drift.
      let qr: InviteQrPayload | null = null;
      try {
        qr = await invoke<InviteQrPayload>("render_invite_qr", {
          tokenJson: JSON.stringify(token),
        });
      } catch {
        // QR rendering is best-effort — the copyable JSON remains usable.
      }
      setInviteLink(qr?.link ?? null);
      setQrUrl(qr?.qr_data_url ?? null);
      await refresh();
    } catch (err) {
      setMintError(String(err));
    } finally {
      setMinting(false);
    }
  };

  const handleCopyLink = async () => {
    if (!inviteLink) return;
    try {
      await writeText(inviteLink);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      // Clipboard plugin unavailable — fallback to navigator.
      try {
        await navigator.clipboard.writeText(inviteLink);
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 1800);
      } catch {
        // no-op
      }
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
    const required = v.min_contacts_required ?? 5;
    // Under a Genesis/Admin bypass the age and contact chips describe state
    // that is explicitly not gating issuance, so mark them waived rather than
    // failing. The moderation-flag chip is never waived and always reflects the
    // real gate.
    const waived = standing.bypassed;
    const chips: { ok: boolean; label: string; waived?: boolean }[] = [
      {
        ok: v.account_age_ok,
        label: `Account ${v.account_age_days}d`,
        waived: waived && !v.account_age_ok,
      },
      {
        ok: v.contacts_ok,
        label: `${v.contact_count}/${required} contacts`,
        waived: waived && !v.contacts_ok,
      },
      { ok: v.flags_ok, label: `${v.active_moderation_flags} mod flags` },
    ];
    return chips.map((c) => {
      const passing = c.ok;
      return (
        <span
          key={c.label}
          data-testid={`vetting-chip-${c.label.replace(/[^a-z0-9]+/gi, "-")}`}
          title={
            passing
              ? "Requirement met"
              : c.waived
                ? "Waived — Genesis / Operator bypass"
                : "Requirement not yet met"
          }
          style={{
            fontSize: "0.72rem",
            padding: "0.15rem 0.5rem",
            borderRadius: "999px",
            background: passing ? "#ecfdf5" : c.waived ? "#eef2ff" : "#fffbeb",
            color: passing ? "#047857" : c.waived ? "#3730a3" : "#92400e",
            border: `1px solid ${passing ? "#a7f3d0" : c.waived ? "#c7d2fe" : "#fde68a"}`,
            fontWeight: 600,
            textDecoration: c.waived ? "line-through" : "none",
          }}
        >
          {passing ? "✓" : c.waived ? "⊘" : "✗"} {c.label}
        </span>
      );
    });
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
                ...(standing.is_genesis ? GENESIS_STYLE : ROLE_STYLE[issuer?.role ?? "member"]),
                fontSize: "0.72rem",
                padding: "0.15rem 0.55rem",
                borderRadius: "999px",
                fontWeight: 700,
              }}
            >
              {standing.is_genesis ? "Genesis / Operator" : ROLE_LABEL[issuer?.role ?? "member"]}
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

      {standing.notice && (
        <div
          data-testid="invite-bypass-notice"
          role="status"
          style={{
            padding: "0.5rem 0.8rem",
            borderRadius: "6px",
            background: "#eef2ff",
            border: "1px solid #c7d2fe",
            color: "#3730a3",
            fontSize: "0.8rem",
            marginBottom: "0.75rem",
          }}
        >
          {"\u2299\uFE0F"} {standing.notice}
        </div>
      )}

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
                  Share the link below (or scan the QR) with the person you are
                  inviting. Scanning opens the airlock page, which decodes the
                  token and validates it against your DID.
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
                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                      <button
                        type="button"
                        data-testid="invite-copy-json"
                        onClick={handleCopy}
                        style={{ fontSize: "0.82rem" }}
                      >
                        {copied ? "✓ Copied" : "Copy Token JSON"}
                      </button>
                      {inviteLink && (
                        <button
                          type="button"
                          data-testid="invite-copy-link"
                          onClick={handleCopyLink}
                          style={{ fontSize: "0.82rem" }}
                        >
                          {copiedLink ? "✓ Link Copied" : "Copy Invite Link"}
                        </button>
                      )}
                    </div>
                  </div>
                  {qrUrl && (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.35rem" }}>
                      <img
                        data-testid="invite-qr-image"
                        src={qrUrl}
                        alt="Invite link QR code"
                        style={{ width: 180, height: 180, borderRadius: 8, border: "1px solid #e5e7eb" }}
                      />
                      <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
                        Scan to open invite link
                      </span>
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
                    : standing.is_genesis
                      ? " Genesis / Operator: mutual vetting is bypassed so you can seed the first invites."
                      : " Members: ≤ 3 per rolling 30 days, member tier only."}
                </p>

                {standing.notice && (
                  <div
                    data-testid="invite-modal-bypass-notice"
                    role="status"
                    style={{
                      padding: "0.5rem 0.8rem",
                      borderRadius: "6px",
                      background: "#eef2ff",
                      border: "1px solid #c7d2fe",
                      color: "#3730a3",
                      fontSize: "0.8rem",
                      marginBottom: "0.9rem",
                    }}
                  >
                    {"\u2299\uFE0F"} {standing.notice}
                  </div>
                )}

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

                {/* Operator-tunable RFC-002 §5.2 mutual-contact threshold.
                    Persisted enclave-side via `set_vetting_threshold`; it tunes
                    the gate for ordinary members and never disables it. */}
                <label
                  data-testid="invite-threshold-label"
                  style={{ display: "block", marginBottom: "0.9rem", fontSize: "0.85rem", fontWeight: 600 }}
                >
                  Member vetting: need {">="}{" "}
                  <input
                    data-testid="invite-threshold"
                    type="number"
                    min={MIN_CONTACTS_FLOOR}
                    max={MAX_CONTACTS_CEILING}
                    value={thresholdDraft ?? threshold}
                    onChange={(e) => setThresholdDraft(Number(e.target.value))}
                    style={{
                      display: "inline-block",
                      width: "5rem",
                      margin: "0 0.25rem",
                      fontSize: "0.85rem",
                      fontWeight: 600,
                    }}
                  />{" "}
                  mutual contacts (have {contactCount})
                  <span style={{ display: "block", fontWeight: 400, fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>
                    {standing.bypassed
                      ? "Not applied to you: Genesis / Operator bypass. This threshold still applies to ordinary member issuers."
                      : `Applies to ordinary member issuers. Range ${MIN_CONTACTS_FLOOR}–${MAX_CONTACTS_CEILING}.`}
                  </span>
                </label>
                {thresholdDraft !== null ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "-0.5rem", marginBottom: "0.9rem" }}>
                    <button
                      type="button"
                      onClick={handleSaveThreshold}
                      disabled={savingThreshold}
                      data-testid="invite-threshold-save"
                      style={{ fontSize: "0.78rem" }}
                    >
                      {savingThreshold ? "Saving…" : "Save threshold"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setThresholdDraft(null);
                        setThresholdError(null);
                      }}
                      data-testid="invite-threshold-cancel"
                      style={{ fontSize: "0.78rem" }}
                    >
                      Reset
                    </button>
                  </div>
                ) : (
                  thresholdSaved !== null && (
                    <div
                      data-testid="invite-threshold-saved"
                      style={{
                        padding: "0.4rem 0.7rem",
                        borderRadius: "6px",
                        background: "#ecfdf5",
                        border: "1px solid #a7f3d0",
                        color: "#047857",
                        fontSize: "0.78rem",
                        marginTop: "-0.5rem",
                        marginBottom: "0.9rem",
                      }}
                    >
                      ✓ Threshold applied: need {"≥"} {thresholdSaved} mutual contacts
                    </div>
                  )
                )}
                {thresholdError && (
                  <div
                    data-testid="invite-threshold-error"
                    style={{
                      padding: "0.5rem 0.8rem",
                      borderRadius: "6px",
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                      color: "#b91c1c",
                      fontSize: "0.8rem",
                      marginTop: "-0.5rem",
                      marginBottom: "0.9rem",
                    }}
                  >
                    {thresholdError}
                  </div>
                )}

                <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.9rem" }}>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600, flex: 1 }}>
                    {`Max uses (1–${maxUsesLimitValue})`}
                    <input
                      data-testid="invite-max-uses"
                      type="number"
                      min={1}
                      max={maxUsesLimitValue}
                      value={maxUses}
                      onChange={(e) =>
                        setMaxUses(
                          Math.max(1, Math.min(maxUsesLimitValue, Number(e.target.value) || 1)),
                        )
                      }
                      style={{ display: "block", width: "100%", marginTop: "0.3rem", fontSize: "0.85rem" }}
                    />
                  </label>
                  {(standing.is_genesis || standing.is_admin) && maxUsesLimitValue > 4 && (
                    <span
                      data-testid="invite-max-uses-hint"
                      style={{ alignSelf: "flex-end", fontSize: "0.74rem", color: "#6b7280", marginBottom: "1.35rem" }}
                    >
                      Community-scale codes enabled for Genesis / Operator
                    </span>
                  )}
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

                {standing.blocked_reason && (
                  <div
                    data-testid="invite-blocked-reason"
                    style={{
                      padding: "0.5rem 0.8rem",
                      borderRadius: "6px",
                      background: "#fffbeb",
                      border: "1px solid #fde68a",
                      color: "#92400e",
                      fontSize: "0.8rem",
                      marginBottom: "0.85rem",
                    }}
                  >
                    {"\u26A0\uFE0F"} {standing.blocked_reason}
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "0.25rem" }}>
                  <button type="button" onClick={closeModal} data-testid="invite-cancel-modal">
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleMint}
                    disabled={minting || !standing.can_mint}
                    data-testid="invite-submit"
                    title={standing.blocked_reason ?? undefined}
                    style={{ opacity: minting || !standing.can_mint ? 0.6 : 1 }}
                  >
                    {minting
                      ? "\u23F3 Minting…"
                      : standing.bypassed
                        ? "\u2709\uFE0F Mint & Sign (bypassed)"
                        : "\u2709\uFE0F Mint & Sign"}
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