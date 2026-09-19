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
import { invoke } from "@tauri-apps/api/core";
import type {
  CustodyStage,
  GrantCapability,
  PodEscrowCeremony,
} from "../../lib/types";
import {
  CUSTODY_STAGE,
  capabilityTag,
} from "../../lib/types";

interface PodBindingModalProps {
  onClose: () => void;
  onBound: () => void;
  onError?: (msg: string) => void;
}

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: "1rem",
};

const CARD: React.CSSProperties = {
  background: "#fff",
  borderRadius: "12px",
  boxShadow: "0 20px 40px rgba(0,0,0,0.25)",
  padding: "1.5rem",
  maxWidth: "640px",
  width: "100%",
  maxHeight: "90vh",
  overflowY: "auto",
};

const COPY_PAYLOAD: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.68rem",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  padding: "0.5rem",
  overflowWrap: "anywhere",
  userSelect: "all",
};

/** Edge-bound pod IDs: `pod_` + uuid. */
function newPodId(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `pod_${rand}`;
}

/** RFC-005 §4.1 binding ceremony modal. */
export default function PodBindingModal({ onClose, onBound, onError }: PodBindingModalProps) {
  const [step, setStep] = useState<"identity" | "ceremony">("identity");
  const [deviceAlias, setDeviceAlias] = useState("");
  const [custodyStage, setCustodyStage] = useState<CustodyStage>(CUSTODY_STAGE.Supervised);
  const [childDidOverride, setChildDidOverride] = useState("");
  const [childPubkeyOverride, setChildPubkeyOverride] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ceremony, setCeremony] = useState<PodEscrowCeremony | null>(null);
  const [copied, setCopied] = useState<"satellite" | "sheet" | null>(null);
  const [grantToggle, setGrantToggle] = useState<Record<string, boolean>>({
    relayDeny: true,
    coSign: false,
    platform: false,
  });
  const [grantResult, setGrantResult] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const fail = (msg: string) => {
    setError(msg);
    onError?.(msg);
  };

  const canGenerate = deviceAlias.trim().length > 0 && !busy;

  const handleGenerate = async () => {
    setError(null);
    setBusy(true);
    setGrantResult(null);
    try {
      const podId = newPodId();
      const c = (await invoke("generate_pod_escrow_shares", {
        podId,
        custodyStage,
      })) as PodEscrowCeremony;

      // If the child's public identity was supplied up front, it must match
      // the edge ceremony identity — otherwise the ceremony DID not come from
      // the same seed the escrow shares were split from.
      if (childDidOverride.trim() && childDidOverride.trim() !== c.child_did) {
        throw new Error(
          "ceremony identity mismatch: the supplied child DID does not match the edge ceremony identity",
        );
      }
      if (childPubkeyOverride.trim() && childPubkeyOverride.trim() !== c.child_nostr_pubkey_hex) {
        throw new Error(
          "ceremony identity mismatch: the supplied Nostr public key does not match the edge ceremony identity",
        );
      }

      await invoke("bind_child_pod", {
        childDid: c.child_did,
        childPubkey: c.child_nostr_pubkey_hex,
        childDeviceId: deviceAlias.trim(),
        custodyStage,
      });

      setCeremony(c);
      setStep("ceremony");
    } catch (e) {
      fail(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (which: "satellite" | "sheet") => {
    const payload =
      which === "satellite" ? ceremony?.satellite_payload_b64 : ceremony?.sheet_payload_b64;
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(which);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard may be unavailable in some contexts; the payload stays
      // selectable in its text box.
    }
  };

  const selectedCapabilities = (): GrantCapability[] => {
    const caps: GrantCapability[] = [];
    if (grantToggle.relayDeny) {
      caps.push({ scope: "relay", effect: "deny", relay_id: null, boundary: null, threshold: null });
    }
    if (grantToggle.coSign) {
      caps.push({ scope: "contact_approval", effect: "co_sign_required", relay_id: null, boundary: null, threshold: 2 });
    }
    if (grantToggle.platform) {
      caps.push({ scope: "platform_boundary", effect: "enforce", relay_id: null, boundary: "restricted_feed_indexing", threshold: null });
    }
    return caps;
  };

  const handleIssueGrant = async () => {
    if (!ceremony) return;
    const caps = selectedCapabilities();
    setGrantError(null);
    setGrantResult(null);
    if (caps.length === 0) {
      setGrantError("Select at least one capability.");
      return;
    }
    try {
      await invoke("create_supervisory_grant", {
        podId: ceremony.pod_id,
        capabilities: caps,
        validDays: 30,
      });
      setGrantResult(
        `Grant issued \u2014 ${caps.map(capabilityTag).join(", ")} (30 days, kind:9114).`,
      );
    } catch (e) {
      setGrantError(String(e));
    }
  };

  const finish = () => onBound();

  return (
    <div style={OVERLAY} data-testid="pod-binding-modal">
      <div style={CARD}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
          <h3 style={{ margin: 0 }}>{"\uD83D\uDD17"} Bind Dependent Device</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            data-testid="pod-binding-close"
            style={{ border: "none", background: "transparent", fontSize: "1.1rem", cursor: "pointer" }}
          >
            {"\u2715"}
          </button>
        </div>

        {error && <div className="error-message" data-testid="pod-binding-error">{error}</div>}

        {step === "identity" && (
          <div>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              The child&apos;s root seed is generated <strong>on the child&apos;s own
              device</strong> (edge generation). This ceremony mints that identity
              inside the local enclave, splits the seed into three Shamir escrow
              shares, and records only public metadata in the parent vault.
            </p>

            <label style={labelStyle} htmlFor="pod-device-alias">
              Device alias (handle)
            </label>
            <input
              id="pod-device-alias"
              data-testid="pod-device-alias"
              value={deviceAlias}
              onChange={(e) => setDeviceAlias(e.target.value)}
              placeholder="e.g. Ari\u2019s iPad"
              style={inputStyle}
            />

            <label style={labelStyle} htmlFor="pod-custody-stage">
              Custody stage
            </label>
            <select
              id="pod-custody-stage"
              data-testid="pod-custody-stage"
              value={String(custodyStage)}
              onChange={(e) => setCustodyStage(Number(e.target.value) as CustodyStage)}
              style={inputStyle}
            >
              <option value={CUSTODY_STAGE.Supervised}>Supervised (&lt;13)</option>
              <option value={CUSTODY_STAGE.Teen}>Teen (13\u201317)</option>
            </select>

            <label style={labelStyle} htmlFor="pod-child-did">
              Child public DID <span style={{ fontWeight: 400, color: "#94a3b8" }}>(optional override)</span>
            </label>
            <input
              id="pod-child-did"
              data-testid="pod-child-did"
              value={childDidOverride}
              onChange={(e) => setChildDidOverride(e.target.value)}
              placeholder="did:key:z6Mk\u2026  (auto-minted if empty)"
              style={inputStyle}
            />

            <label style={labelStyle} htmlFor="pod-child-pubkey">
              Child Nostr public key <span style={{ fontWeight: 400, color: "#94a3b8" }}>(optional override)</span>
            </label>
            <input
              id="pod-child-pubkey"
              data-testid="pod-child-pubkey"
              value={childPubkeyOverride}
              onChange={(e) => setChildPubkeyOverride(e.target.value)}
              placeholder="64 hex chars \u2026 (auto-minted if empty)"
              style={inputStyle}
            />

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1rem" }}>
              <button onClick={onClose}>Cancel</button>
              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                data-testid="pod-generate"
              >
                {busy ? "Generating\u2026" : "Generate Pod &amp; Escrow Shares"}
              </button>
            </div>
          </div>
        )}

        {step === "ceremony" && ceremony && (
          <div>
            <div
              style={{
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: "8px",
                padding: "0.7rem 1rem",
                marginBottom: "1rem",
                fontSize: "0.85rem",
              }}
              data-testid="pod-binding-success"
            >
              Pod <code>{ceremony.pod_id}</code> bound. Child identity:
              <br />
              <code className="did-display" style={{ fontSize: "0.72rem" }}>{ceremony.child_did}</code>
              <br />
              <span className="muted">Share 1 (parent) saved automatically to <code>escrow_store.json</code>.</span>
            </div>

            <div style={{ marginBottom: "1rem" }}>
              <div style={{ fontWeight: 600, fontSize: "0.9rem", marginBottom: "0.35rem" }}>
                2-of-3 Shamir escrow split complete
              </div>
              <ul className="muted" style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.82rem", lineHeight: 1.7 }}>
                <li>
                  <strong>Share 1 (parent):</strong> sealed into the parent escrow store.{" "}
                  <button
                    data-testid="pod-copy-parent"
                    style={chipButton}
                    onClick={() => handleCopy("satellite")}
                  >
                    {copied === "satellite" ? "Copied" : "Copy"}
                  </button>{" "}
                  — never needs to cross any wire; kept offline.
                </li>
                <li>
                  <strong>Share 2 (satellite):</strong> enroll with the satellite
                  time-lock (unlocks for recovery at adulthood /{" "}
                  <code>{new Date(ceremony.unlock_at * 1000).toLocaleDateString()}</code>).
                </li>
                <li>
                  <strong>Share 3 (cold sheet):</strong> print a high-contrast
                  Emergency Recovery Cold Sheet and store it with the household.
                </li>
              </ul>
            </div>

            <div style={{ display: "grid", gap: "0.75rem", marginBottom: "1rem" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.3rem" }}>
                  Satellite time-lock enrollment payload (Share 2)
                </div>
                <div style={COPY_PAYLOAD} data-testid="pod-satellite-payload">
                  {ceremony.satellite_payload_b64}
                </div>
                <button data-testid="pod-copy-satellite" style={chipButton} onClick={() => handleCopy("satellite")}>
                  {copied === "satellite" ? "\u2713 Copied" : "\uD83D\uDCCB Copy Share 2"}
                </button>
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.3rem" }}>
                  Emergency Recovery Cold Sheet (Share 3)
                </div>
                <div
                  style={{ ...COPY_PAYLOAD, background: "#0f172a", color: "#f8fafc", borderColor: "#334155" }}
                  data-testid="pod-sheet-payload"
                >
                  {ceremony.sheet_payload_b64}
                </div>
                <button data-testid="pod-copy-sheet" style={chipButton} onClick={() => handleCopy("sheet")}>
                  {copied === "sheet" ? "\u2713 Copied" : "\uD83C\uDFC5 Copy Share 3"}
                </button>
              </div>
            </div>

            <div
              style={{ borderTop: "1px solid #e2e8f0", paddingTop: "0.85rem", marginBottom: "1rem" }}
            >
              <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.4rem" }}>
                Issue first supervisory grant (kind:9114)
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {(
                  [
                    ["relayDeny", "Safe Relays Only"],
                    ["coSign", "Co-Sign Required"],
                    ["platform", "Enforce Safe Platform Mode"],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      border: grantToggle[key] ? "1px solid #93c5fd" : "1px solid #cbd5e1",
                      background: grantToggle[key] ? "#eff6ff" : "#f8fafc",
                      borderRadius: "999px",
                      padding: "3px 10px",
                      fontSize: "0.8rem",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={grantToggle[key]}
                      onChange={() => setGrantToggle((t) => ({ ...t, [key]: !t[key] }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginTop: "0.6rem" }}>
                <button onClick={handleIssueGrant} data-testid="pod-issue-grant">
                  Issue 30-day grant
                </button>
                {grantResult && (
                  <span style={{ fontSize: "0.8rem", color: "#166534" }} data-testid="pod-grant-result">
                    {grantResult}
                  </span>
                )}
              </div>
              {grantError && <div className="error-message" data-testid="pod-grant-error">{grantError}</div>}
              {grantResult && (
                <div style={{ marginTop: "0.5rem" }}>
                  <button data-testid="pod-issue-another" style={chipButton} onClick={() => { setGrantResult(null); }}>
                    Issue another grant
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button onClick={onClose}>Close</button>
              <button onClick={finish} data-testid="pod-finish">
                {"\u2713"} Finish Binding
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontWeight: 600,
  fontSize: "0.8rem",
  marginBottom: "0.25rem",
  marginTop: "0.6rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "0.5rem 0.65rem",
  borderRadius: "6px",
  border: "1px solid #cbd5e1",
  fontSize: "0.85rem",
};

const chipButton: React.CSSProperties = {
  border: "1px solid #cbd5e1",
  background: "#fff",
  borderRadius: "6px",
  padding: "2px 8px",
  fontSize: "0.72rem",
  cursor: "pointer",
  marginLeft: "0.35rem",
};