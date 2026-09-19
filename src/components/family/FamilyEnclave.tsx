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

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChildPodEntry, CustodyStage } from "../../lib/types";
import {
  CUSTODY_STAGE,
  custodyLabel,
} from "../../lib/types";
import PodBindingModal from "./PodBindingModal";

/**
 * RFC-005 Family & Delegations enclave: lists bound custodial seed pods
 * (children with their OWN edge devices). The parent vault holds public
 * metadata + one Shamir escrow share — never a child's seed.
 */
export default function FamilyEnclave() {
  const [pods, setPods] = useState<ChildPodEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showBind, setShowBind] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  const [armId, setArmId] = useState<string | null>(null);

  const loadPods = useCallback(async () => {
    try {
      const list = (await invoke("list_child_pods")) as ChildPodEntry[];
      setPods(list ?? []);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    loadPods();
  }, [loadPods]);

  const handleStartBind = () => {
    setBindError(null);
    setShowBind(true);
  };

  const handleBound = () => {
    setShowBind(false);
    loadPods();
  };

  const handleEmancipate = async (pod: ChildPodEntry) => {
    if (armId !== pod.pod_id) {
      // Two-step confirmation: click once to arm, again to confirm.
      setArmId(pod.pod_id);
      return;
    }
    setArmId(null);
    try {
      await invoke("emancipate_child_pod", { podId: pod.pod_id });
      await loadPods();
    } catch (e) {
      setError(String(e));
    }
  };

  const pillStyle = (stage: CustodyStage): React.CSSProperties => {
    if (stage === CUSTODY_STAGE.Emancipated) {
      return {
        background: "#dcfce7",
        color: "#166534",
        border: "1px solid #86efac",
        borderRadius: "999px",
        padding: "2px 10px",
        fontSize: "0.75rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
      };
    }
    if (stage === CUSTODY_STAGE.Teen) {
      return {
        background: "#dbeafe",
        color: "#1e40af",
        border: "1px solid #93c5fd",
        borderRadius: "999px",
        padding: "2px 10px",
        fontSize: "0.75rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
      };
    }
    return {
      background: "#ffedd5",
      color: "#9a3412",
      border: "1px solid #fed7aa",
      borderRadius: "999px",
      padding: "2px 10px",
      fontSize: "0.75rem",
      fontWeight: 600,
      whiteSpace: "nowrap",
    };
  };

  const grantTags = (grants: string[]): string[] => grants;

  return (
    <div className="section">
      <h3>{"\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC66"} Family &amp; Delegations</h3>
      <p className="muted" style={{ marginBottom: "0.75rem" }}>
        Custodial seed pods for children running their own devices. The parent
        vault stores public DIDs and custody metadata only — never a child&apos;s
        seed. Disaster recovery uses a 2-of-3 Shamir escrow split across parent,
        satellite, and the printed cold sheet.
      </p>

      {bindError && <div className="error-message">{bindError}</div>}

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <button onClick={handleStartBind} data-testid="family-open-bind">
          {"\uD83D\uDD17"} Bind Dependent Device
        </button>
      </div>

      {pods.length === 0 ? (
        <p className="muted" data-testid="family-empty">
          No child pods bound yet. Bind a dependent device to start
          supervised pairing, or wait for an existing pod to graduate.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.75rem" }}>
          {pods.map((pod) => (
            <li
              key={pod.pod_id}
              data-testid={`family-pod-${pod.pod_id}`}
              style={{
                border: "1px solid var(--color-border, #e2e8f0)",
                borderRadius: "8px",
                padding: "0.85rem 1rem",
                background: "var(--color-bg-secondary, #f8fafc)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: "0.95rem" }} data-testid={`family-pod-alias-${pod.pod_id}`}>
                  {pod.child_device_id || "Unnamed device"}
                </span>
                <span style={pillStyle(pod.custody_stage)} data-testid={`family-pod-stage-${pod.pod_id}`}>
                  {custodyLabel(pod.custody_stage)}
                </span>
                <span style={{ fontSize: "0.75rem", color: "var(--color-text-secondary, #64748b)" }}>
                  {pod.emancipated_at ? `Emancipated ${new Date(pod.emancipated_at * 1000).toLocaleDateString()}` : `Bound ${new Date(pod.bound_at * 1000).toLocaleDateString()}`}
                </span>
              </div>

              <div style={{ marginTop: "0.4rem", overflowWrap: "anywhere" }}>
                <code className="did-display" style={{ fontSize: "0.72rem" }}>
                  {pod.child_did}
                </code>
              </div>

              {pod.active_grants.length > 0 ? (
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                  {grantTags(pod.active_grants).map((g) => (
                    <span
                      key={g}
                      data-testid={`family-pod-grant-${pod.pod_id}`}
                      style={{
                        background: "#f1f5f9",
                        border: "1px solid #cbd5e1",
                        borderRadius: "999px",
                        padding: "1px 8px",
                        fontSize: "0.7rem",
                        color: "#334155",
                      }}
                    >
                      {g.length > 12 ? `${g.slice(0, 9)}\u2026` : g}
                    </span>
                  ))}
                </div>
              ) : (
                <div
                  style={{ fontSize: "0.72rem", color: "var(--color-text-secondary, #64748b)", marginTop: "0.5rem" }}
                  data-testid={`family-pod-nogrants-${pod.pod_id}`}
                >
                  No active supervisory grants
                </div>
              )}

              {pod.custody_stage !== CUSTODY_STAGE.Emancipated && (
                <div style={{ marginTop: "0.6rem" }}>
                  <button
                    data-testid={`family-emancipate-${pod.pod_id}`}
                    onClick={() => handleEmancipate(pod)}
                    style={
                      armId === pod.pod_id
                        ? { background: "#dc2626", color: "#fff", border: "none", fontSize: "0.8rem", padding: "4px 12px", borderRadius: "6px", cursor: "pointer" }
                        : undefined
                    }
                  >
                    {armId === pod.pod_id
                      ? "\u26A0\uFE0F Confirm Emancipation"
                      : "Emancipate (18+ / graduate)"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {showBind && (
        <PodBindingModal
          onClose={() => setShowBind(false)}
          onBound={handleBound}
          onError={(msg) => setBindError(msg)}
        />
      )}

      {error && <div className="error-message">{error}</div>}
    </div>
  );
}