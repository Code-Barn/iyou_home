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
 * Satellite Admin & Moderation panel — RFC-003.
 *
 * Probes the connected node with `admin_probe`; when the active Level 1 DID
 * is an authorized `admin_dids` entry it unlocks three tabs: the member
 * directory (with Sever / Ban actions), the bans & audit ledger, and the
 * RFC-002 invite referral graph. Unauthorized DIDs get a lock badge instead.
 */

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AdminProbeResult,
  BanRecord,
  InviteRecord,
  MemberRecord,
  ModerationAction,
} from "../../lib/types";
import BanModal from "./BanModal";

type AdminTab = "members" | "bans" | "graph";

const TAB_STYLE = (active: boolean): CSSProperties => ({
  padding: "0.6rem 1.2rem",
  background: active ? "#312e81" : "transparent",
  color: active ? "#ffffff" : "#4b5563",
  border: "none",
  borderRadius: "6px",
  fontWeight: 600,
  fontSize: "0.9rem",
  cursor: "pointer",
  transition: "all 0.15s",
});

const PILL = (bg: string, fg: string, border: string): CSSProperties => ({
  fontSize: "0.72rem",
  padding: "0.15rem 0.55rem",
  borderRadius: "999px",
  fontWeight: 700,
  background: bg,
  color: fg,
  border: `1px solid ${border}`,
});

function formatDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString();
}

function shortDid(did: string): string {
  if (!did) return "—";
  return did.length > 26 ? `${did.slice(0, 12)}…${did.slice(-10)}` : did;
}

export default function AdminPanel() {
  const [probe, setProbe] = useState<AdminProbeResult | null>(null);
  const [tab, setTab] = useState<AdminTab>("members");
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [bans, setBans] = useState<BanRecord[]>([]);
  const [actions, setActions] = useState<ModerationAction[]>([]);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<MemberRecord | null>(null);
  const [severBusy, setSeverBusy] = useState<string | null>(null);
  const [unbanBusy, setUnbanBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [memberRows, banRows, auditRows, inviteRows] = await Promise.all([
        invoke<MemberRecord[]>("admin_list_members", { satelliteId: "" }),
        invoke<BanRecord[]>("admin_list_bans", { satelliteId: "" }),
        invoke<ModerationAction[]>("admin_list_actions", { satelliteId: "", limit: 100 }),
        invoke<InviteRecord[]>("list_invites"),
      ]);
      setMembers(memberRows);
      setBans(banRows);
      setActions(auditRows);
      setInvites(inviteRows);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    const probeNode = async () => {
      try {
        const result = await invoke<AdminProbeResult>("admin_probe", { satelliteId: "" });
        setProbe(result);
        if (result.authorized) {
          await refresh();
        }
      } catch {
        setProbe({ authorized: false, admin_did: null, satellite_id: null });
      } finally {
        setLoading(false);
      }
    };
    void probeNode();
  }, [refresh]);

  const handleSever = async (did: string) => {
    setSeverBusy(did);
    try {
      await invoke<number>("admin_sever", { satelliteId: "", targetDid: did });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setSeverBusy(null);
    }
  };

  const handleUnban = async (did: string) => {
    setUnbanBusy(did);
    try {
      await invoke("admin_unban", { satelliteId: "", targetDid: did });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setUnbanBusy(null);
    }
  };

  const onBanned = async () => {
    // Refresh the panels underneath the modal. The modal stays open on its
    // report screen — the admin reviews the outcome and dismisses it with the
    // "Done" button, which calls onClose → setBanTarget(null).
    await refresh();
  };

  if (loading) {
    return <div data-testid="admin-panel">Probing node authority…</div>;
  }

  if (!probe?.authorized) {
    return (
      <div data-testid="admin-panel">
        <div
          data-testid="admin-lock-badge"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "1rem 1.25rem",
            borderRadius: "8px",
            background: "#fffbeb",
            border: "1px solid #fde68a",
          }}
        >
          <span style={{ fontSize: "1.4rem" }}>{"\uD83D\uDD12"}</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: "0.95rem", color: "#92400e" }}>
              Admin access locked
            </div>
            <div style={{ fontSize: "0.82rem", color: "#92400e", marginTop: "0.2rem" }}>
              The active Level 1 DID is not an authorized <code>admin_dids</code> entry.
              Role {"admin"} is granted via <code>set_issuer_role</code> (mirrors the
              node-side admin list). Every <code>admin_*</code> command returns{" "}
              <code>403 Forbidden</code> for unlisted DIDs.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="admin-panel">
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
            {"\uD83D\uDEE1\uFE0F"} Satellite Admin
          </h3>
          <div style={{ fontSize: "0.8rem", color: "#6b7280", marginTop: "0.25rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span
              data-testid="admin-role"
              style={PILL("#312e81", "#ffffff", "#312e81")}
            >
              role: ADMIN
            </span>
            {probe.admin_did && (
              <span style={{ fontFamily: "monospace", fontSize: "0.72rem" }}>
                {shortDid(probe.admin_did)}
              </span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div
          data-testid="admin-error"
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

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", borderBottom: "2px solid #e5e7eb", paddingBottom: "0.5rem" }}>
        <button type="button" data-testid="admin-tab-members" style={TAB_STYLE(tab === "members")} onClick={() => setTab("members")}>
          {"\uD83D\uDCC7"} Members
        </button>
        <button type="button" data-testid="admin-tab-bans" style={TAB_STYLE(tab === "bans")} onClick={() => setTab("bans")}>
          {"\u26A0\uFE0F"} Bans &amp; Audit
        </button>
        <button type="button" data-testid="admin-tab-graph" style={TAB_STYLE(tab === "graph")} onClick={() => setTab("graph")}>
          {"\uD83D\uDCC1"} Invite Graph
        </button>
      </div>

      {tab === "members" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "2px solid #e5e7eb" }}>
                <th style={{ padding: "0.4rem 0.6rem" }}>DID</th>
                <th style={{ padding: "0.4rem 0.6rem" }}>Joined</th>
                <th style={{ padding: "0.4rem 0.6rem" }}>Referrer</th>
                <th style={{ padding: "0.4rem 0.6rem" }}>Flags</th>
                <th style={{ padding: "0.4rem 0.6rem" }}>Status</th>
                <th style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: "1rem 0.6rem", color: "#9ca3af" }}>
                    No members yet.
                  </td>
                </tr>
              )}
              {members.map((m) => (
                <tr key={m.did} data-testid={`member-row-${m.did}`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "0.5rem 0.6rem", fontFamily: "monospace", fontSize: "0.75rem" }}>{shortDid(m.did)}</td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>{formatDate(m.joined_at)}</td>
                  <td style={{ padding: "0.5rem 0.6rem", fontFamily: "monospace", fontSize: "0.72rem" }}>
                    {m.referrer_did ? shortDid(m.referrer_did) : "—"}
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    {m.flags > 0 ? (
                      <span style={PILL("#fef2f2", "#b91c1c", "#fecaca")}>{m.flags}</span>
                    ) : (
                      <span style={PILL("#ecfdf5", "#047857", "#a7f3d0")}>0</span>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    <span
                      data-testid={`member-status-${m.did}`}
                      style={m.status === "banned" ? PILL("#fef2f2", "#b91c1c", "#fecaca") : PILL("#ecfdf5", "#047857", "#a7f3d0")}
                    >
                      {m.status}
                    </span>
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem", textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      data-testid={`admin-sever-${m.did}`}
                      onClick={() => handleSever(m.did)}
                      disabled={severBusy === m.did}
                      style={{ fontSize: "0.75rem", marginRight: "0.4rem", color: "#374151" }}
                    >
                      {severBusy === m.did ? "…" : "\u26A0\uFE0F Disconnect"}
                    </button>
                    <button
                      type="button"
                      data-testid={`admin-ban-${m.did}`}
                      onClick={() => setBanTarget(m)}
                      style={{ fontSize: "0.75rem", color: "#b91c1c" }}
                    >
                      {"\u2691"} Ban
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "bans" && (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "2px solid #e5e7eb" }}>
                  <th style={{ padding: "0.4rem 0.6rem" }}>DID</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Reason</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Scope</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Expires</th>
                  <th style={{ padding: "0.4rem 0.6rem" }}>Severed</th>
                  <th style={{ padding: "0.4rem 0.6rem", textAlign: "right" }} />
                </tr>
              </thead>
              <tbody>
                {bans.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: "1rem 0.6rem", color: "#9ca3af" }}>
                      No active bans.
                    </td>
                  </tr>
                )}
                {bans.map((b) => (
                  <tr key={`${b.event_id}`} data-testid={`admin-ban-row-${b.did}`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "0.5rem 0.6rem", fontFamily: "monospace", fontSize: "0.75rem" }}>{shortDid(b.did)}</td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>
                      {b.ban_reason}
                      {b.evidence_sha256 && (
                        <span
                          title={`Evidence: ${b.evidence_sha256}`}
                          style={{ marginLeft: "0.4rem", fontSize: "0.7rem", color: "#6b7280" }}
                        >
                          {"\u26A0\uFE0F"}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>
                      <span style={PILL("#eff6ff", "#1d4ed8", "#bfdbfe")}>{b.scope}</span>
                    </td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>{formatDate(b.expires_at)}</td>
                    <td style={{ padding: "0.5rem 0.6rem" }}>{b.severed_conns}</td>
                    <td style={{ padding: "0.5rem 0.6rem", textAlign: "right" }}>
                      <button
                        type="button"
                        data-testid={`admin-unban-${b.did}`}
                        onClick={() => handleUnban(b.did)}
                        disabled={unbanBusy === b.did}
                        style={{ fontSize: "0.75rem", color: "#047857" }}
                      >
                        {unbanBusy === b.did ? "…" : "Unban"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 style={{ margin: "1.25rem 0 0.5rem", fontSize: "0.9rem", color: "#0f172a" }}>
            {"\uD83D\uDD52"} Audit trail (append-only)
          </h4>
          <div style={{ maxHeight: 300, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 6 }}>
            {actions.length === 0 && (
              <div style={{ padding: "0.75rem", fontSize: "0.8rem", color: "#9ca3af" }}>No moderation actions yet.</div>
            )}
            {actions.map((a) => (
              <div
                key={a.action_id}
                data-testid={`admin-audit-row-${a.action_id}`}
                style={{ padding: "0.4rem 0.7rem", borderBottom: "1px solid #f3f4f6", fontSize: "0.78rem", display: "flex", gap: "0.75rem", alignItems: "center" }}
              >
                <span style={PILL("#f3f4f6", "#374151", "#d1d5db")}>{a.kind}</span>
                <span style={{ fontFamily: "monospace" }}>{shortDid(a.subject_did)}</span>
                <span style={{ color: "#9ca3af" }}>by {shortDid(a.actor_did)}</span>
                <span style={{ color: "#9ca3af", marginLeft: "auto" }}>{formatDate(a.created_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === "graph" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "2px solid #e5e7eb" }}>
                <th style={{ padding: "0.4rem 0.6rem" }}>Issuer</th>
                <th style={{ padding: "0.4rem 0.6rem" }}>Recipient</th>
                <th style={{ padding: "0.4rem 0.6rem" }}>Tier</th>
                <th style={{ padding: "0.4rem 0.6rem" }}>Status</th>
                <th style={{ padding: "0.4rem 0.6rem" }}>Uses</th>
              </tr>
            </thead>
            <tbody>
              {invites.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: "1rem 0.6rem", color: "#9ca3af" }}>
                    No invite edges yet.
                  </td>
                </tr>
              )}
              {invites.map((inv) => (
                <tr key={inv.nonce} data-testid={`admin-graph-row-${inv.nonce}`} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "0.5rem 0.6rem", fontFamily: "monospace", fontSize: "0.75rem" }}>{shortDid(inv.issuer_did)}</td>
                  <td style={{ padding: "0.5rem 0.6rem", fontFamily: "monospace", fontSize: "0.75rem" }}>
                    {inv.child_did ? shortDid(inv.child_did) : "unclaimed"}
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    <span style={PILL("#eff6ff", "#1d4ed8", "#bfdbfe")}>{inv.tier}</span>
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    <span
                      data-testid={`admin-graph-status-${inv.nonce}`}
                      style={inv.status === "revoked" ? PILL("#fef2f2", "#b91c1c", "#fecaca") : PILL("#ecfdf5", "#047857", "#a7f3d0")}
                    >
                      {inv.status}
                    </span>
                  </td>
                  <td style={{ padding: "0.5rem 0.6rem" }}>
                    {inv.uses_count} / {inv.max_uses}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {banTarget && <BanModal target={banTarget} onClose={() => setBanTarget(null)} onBanned={onBanned} />}
    </div>
  );
}