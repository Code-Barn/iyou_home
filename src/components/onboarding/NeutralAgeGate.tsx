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
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgeGateRecord, AgeTier, DisclaimerAuditEntry } from "../../lib/types";

/** RFC-004 §4.2 component contract. */
interface NeutralAgeGateProps {
  /** Called with the sealed bracket record once classification passes. */
  onDecision: (record: AgeGateRecord) => void;
  /** Parent pairing for Child tier is a separate supervisory flow (RFC-005). */
  onNeedsParentPairing: () => void;
}

/**
 * RFC-004 §5.2 canonical teen-safety advisory text. `TEEN_ADVISORY_SHA256` is
 * the SHA-256 of this exact string, so the disclaimer audit entry can be
 * cross-verified against what the user was actually shown.
 */
const TEEN_ADVISORY_TEXT =
  "High-privacy defaults enabled: direct messages are restricted to mutual contacts, feed indexing is restricted, and public persona broadcast is off.";
const TEEN_ADVISORY_SHA256 =
  "51f37b35cd5c77ba06a29877f63e7762d19407d547bee1e27acc3b78df0ebbbd";

/** Current app release label stamped on audit entries. */
const APP_VERSION_LABEL = "0.2.1";

/** Year selector floor (RFC-004 open question #1 resolves to 1920 for the UI;
 *  the enclave rejects years earlier than 1900 with `out_of_range`). */
const YEAR_MIN = 1920;

const MONTHS: { value: number; label: string }[] = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
];

/**
 * Neutral age gate (RFC-004 §4): exactly two controls (birth month + year),
 * zero coaching copy, zero bracket-revealing feedback. The tier is computed in
 * the Rust enclave and only surfaces through the branch UI that follows.
 */
export default function NeutralAgeGate({
  onDecision,
  onNeedsParentPairing,
}: NeutralAgeGateProps) {
  const [month, setMonth] = useState<number | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState<AgeTier | null>(null);
  /** True only after a failed classification — drives the neutral re-check
   *  message. Cleared on any selection change (single re-entry per RFC-004
   *  §4.3, no retry loop, never auto-classify). */
  const [recheck, setRecheck] = useState(false);

  // Years ascend from oldest to current — RFC-004 §4.1 rule 3: descending is
  // prohibited because it normalizes "youngest first" scanning.
  const years = useMemo(() => {
    const current = new Date().getFullYear();
    const list: number[] = [];
    for (let y = YEAR_MIN; y <= current; y += 1) {
      list.push(y);
    }
    return list;
  }, []);

  const ready = month !== null && year !== null && !busy;

  const handleContinue = async () => {
    if (month === null || year === null || busy) return;
    setBusy(true);
    try {
      const result = await invoke<AgeTier>("classify_age", {
        birthMonth: month,
        birthYear: year,
      });
      // RFC-004 §4.3: Adult proceeds directly to the standard create flow;
      // Teen/Child route through their branch UIs (advisory / parent pairing).
      if (result === "adult") {
        emitDecision("adult");
      } else {
        setTier(result);
      }
      setRecheck(false);
    } catch (err: any) {
      // Neutral re-check — never reveal a bracket or hint at age. Single
      // re-entry per RFC-004 §4.3 (no retry loop, never auto-classify).
      setTier(null);
      setRecheck(true);
      console.error("Age gate classification failed:", err.toString());
    } finally {
      setBusy(false);
    }
  };

  const handleTeenAcknowledge = async () => {
    if (month === null || year === null || busy) return;
    setBusy(true);
    const now = Math.floor(Date.now() / 1000);
    try {
      const entry: DisclaimerAuditEntry = {
        entry_id: "",
        disclaimer_sha256: TEEN_ADVISORY_SHA256,
        disclaimer_key: "coppa-teen-safety-v1",
        version_label: APP_VERSION_LABEL,
        shown_at: now,
        accepted_at: now,
        locale: (navigator.language || "en-US").slice(0, 5),
        device_id: "",
        presented_did: "",
        outcome: "accepted",
        context: "onboarding",
      };
      await invoke("record_disclaimer_audit", { entry });
    } catch (err: any) {
      console.error("Failed to record disclaimer audit:", err.toString());
    } finally {
      setBusy(false);
    }
    emitDecision("teen");
  };

  const emitDecision = (finalTier: AgeTier) => {
    if (month === null || year === null) return;
    onDecision({
      gate_version: "neutral-v1",
      tier: finalTier,
      computed_at: Math.floor(Date.now() / 1000),
      month,
      year,
    });
  };

  const handlePairWithParent = () => {
    onNeedsParentPairing();
  };

  // ---------- rendering ----------

  const labelStyle: CSSProperties = {
    display: "block",
    fontSize: "0.78rem",
    color: "#a5b4fc",
    marginBottom: "0.25rem",
    letterSpacing: "0.02em",
  };

  const selectStyle: CSSProperties = {
    width: "100%",
    padding: "0.6rem 0.75rem",
    borderRadius: "8px",
    border: "1px solid #6366f1",
    background: "#0f172a",
    color: "#e0e7ff",
    fontSize: "0.95rem",
  };

  const cardBodyStyle: CSSProperties = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(199, 210, 254, 0.2)",
    borderRadius: "14px",
    padding: "1.4rem 1.5rem",
  };

  return (
    <div data-testid="neutral-age-gate">
      {tier === null && (
        <div style={cardBodyStyle}>
          <h3 style={{ margin: "0 0 0.35rem 0", color: "#fff", fontSize: "1.05rem" }}>
            Birth Month and Year
          </h3>
          <p
            style={{
              margin: "0 0 1.1rem 0",
              fontSize: "0.85rem",
              color: "#c7d2fe",
              lineHeight: 1.5,
            }}
          >
            Choose your birth month and year to continue.
          </p>

          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 200px" }}>
              <label htmlFor="age-gate-month" style={labelStyle}>
                Birth Month
              </label>
              <select
                id="age-gate-month"
                data-testid="age-gate-month"
                value={month ?? ""}
                onChange={(e) => {
                  setMonth(e.target.value ? Number(e.target.value) : null);
                  setRecheck(false);
                }}
                style={selectStyle}
              >
                <option value="" disabled>
                  Select month
                </option>
                {MONTHS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: "1 1 160px" }}>
              <label htmlFor="age-gate-year" style={labelStyle}>
                Birth Year
              </label>
              <select
                id="age-gate-year"
                data-testid="age-gate-year"
                value={year ?? ""}
                onChange={(e) => {
                  setYear(e.target.value ? Number(e.target.value) : null);
                  setRecheck(false);
                }}
                style={selectStyle}
              >
                <option value="" disabled>
                  Select year
                </option>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            onClick={handleContinue}
            disabled={!ready}
            data-testid="age-gate-continue"
            style={{
              width: "100%",
              marginTop: "1.1rem",
              background: ready ? "#10b981" : "rgba(255,255,255,0.08)",
              color: "#ffffff",
              fontWeight: 700,
              border: ready ? "none" : "1px solid #a5b4fc",
              padding: "0.75rem 1.2rem",
              borderRadius: "8px",
              opacity: busy ? 0.6 : 1,
              cursor: ready ? "pointer" : "not-allowed",
              fontSize: "1rem",
            }}
          >
            Continue
          </button>

          {recheck && (
            <p
              data-testid="age-gate-neutral-error"
              style={{
                margin: "0.75rem 0 0 0",
                fontSize: "0.82rem",
                color: "#fbbf24",
              }}
            >
              Please re-check the selected date.
            </p>
          )}
        </div>
      )}

      {tier === "teen" && (
        <div style={cardBodyStyle} data-testid="age-gate-teen-advisory">
          <h3 style={{ margin: "0 0 0.5rem 0", color: "#fff", fontSize: "1.05rem" }}>
            Privacy Note
          </h3>
          <p
            style={{
              margin: "0 0 1rem 0",
              fontSize: "0.92rem",
              color: "#c7d2fe",
              lineHeight: 1.6,
            }}
          >
            {TEEN_ADVISORY_TEXT}
          </p>
          <button
            onClick={handleTeenAcknowledge}
            disabled={busy}
            data-testid="age-gate-teen-acknowledge"
            style={{
              width: "100%",
              background: "#10b981",
              color: "#ffffff",
              fontWeight: 700,
              border: "none",
              padding: "0.75rem 1.2rem",
              borderRadius: "8px",
              opacity: busy ? 0.6 : 1,
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: "1rem",
            }}
          >
            {busy ? "Saving…" : "I Understand & Continue"}
          </button>
        </div>
      )}

      {tier === "child" && (
        <div style={cardBodyStyle} data-testid="age-gate-child-card">
          <h3 style={{ margin: "0 0 0.5rem 0", color: "#fff", fontSize: "1.05rem" }}>
            Parent or Guardian Required
          </h3>
          <p
            style={{
              margin: "0 0 1rem 0",
              fontSize: "0.95rem",
              color: "#c7d2fe",
              lineHeight: 1.6,
            }}
          >
            To setup an identity for an individual under 13, please pair this
            device with a parent or guardian&apos;s iyou_home enclave.
          </p>
          <button
            onClick={handlePairWithParent}
            data-testid="age-gate-pair-parent"
            style={{
              width: "100%",
              background: "#6366f1",
              color: "#ffffff",
              fontWeight: 700,
              border: "none",
              padding: "0.75rem 1.2rem",
              borderRadius: "8px",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            Pair with Parent Enclave
          </button>
        </div>
      )}
    </div>
  );
}