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

import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { EnclaveDiagnostics } from "../lib/types";

interface SovereigntyStatusPanelProps {
  onServiceToggled?: () => void;
  onNavigateTab?: (tab: string) => void;
  defaultExpanded?: boolean;
}

interface RelayProbeResult {
  url: string;
  status: "connected" | "connecting" | "failed";
  latencyMs?: number;
}

function truncateDid(did: string, lead = 18, tail = 6): string {
  if (!did || did.length <= lead + tail + 3) return did || "";
  return `${did.slice(0, lead)}...${did.slice(-tail)}`;
}

export default function SovereigntyStatusPanel({
  onServiceToggled,
  onNavigateTab,
  defaultExpanded = false,
}: SovereigntyStatusPanelProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [diagnostics, setDiagnostics] = useState<EnclaveDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Relay mesh live probe states
  const [relayResults, setRelayResults] = useState<Record<string, RelayProbeResult>>({});
  const [probingRelays, setProbingRelays] = useState(false);
  const [newRelayUrl, setNewRelayUrl] = useState("");
  const [showAddRelay, setShowAddRelay] = useState(false);

  // Backup modal state
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupConfirmPassword, setBackupConfirmPassword] = useState("");
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  // Action busy states
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  // Probe single relay via WebSocket with timeout
  const probeRelay = useCallback((url: string): Promise<RelayProbeResult> => {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let resolved = false;

      try {
        const ws = new WebSocket(url);

        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve({ url, status: "failed" });
          }
        }, 3000);

        ws.onopen = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            const latency = Date.now() - startTime;
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve({ url, status: "connected", latencyMs: latency });
          }
        };

        ws.onerror = () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve({ url, status: "failed" });
          }
        };
      } catch {
        resolve({ url, status: "failed" });
      }
    });
  }, []);

  // Probe all configured relays
  const probeAllRelays = useCallback(
    async (relaysList: string[]) => {
      if (!relaysList || relaysList.length === 0) return;
      setProbingRelays(true);

      const initialMap: Record<string, RelayProbeResult> = {};
      relaysList.forEach((url) => {
        initialMap[url] = { url, status: "connecting" };
      });
      setRelayResults(initialMap);

      const results = await Promise.all(relaysList.map((url) => probeRelay(url)));
      const finalMap: Record<string, RelayProbeResult> = {};
      results.forEach((res) => {
        finalMap[res.url] = res;
      });
      setRelayResults(finalMap);
      setProbingRelays(false);
    },
    [probeRelay],
  );

  // Fetch full diagnostics from backend
  const fetchDiagnostics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<EnclaveDiagnostics>("get_enclave_diagnostics");
      setDiagnostics(data);
      if (data?.relay_gossip_mesh?.relays) {
        probeAllRelays(data.relay_gossip_mesh.relays);
      }
    } catch (err: any) {
      console.error("Failed to load enclave diagnostics:", err);
      setError(err?.toString() || "Failed to query enclave diagnostics");
    } finally {
      setLoading(false);
    }
  }, [probeAllRelays]);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  // Handler: Start a local service (Nostr or Blossom)
  const handleStartService = async (serviceName: "Nostr" | "Blossom") => {
    setActionBusy(serviceName);
    try {
      await invoke("toggle_service", { name: serviceName, action: "start" });
      onServiceToggled?.();
      await fetchDiagnostics();
    } catch (err: any) {
      console.error(`Failed to start ${serviceName}:`, err);
    } finally {
      setActionBusy(null);
    }
  };

  // Handler: Add custom public relay to mesh
  const handleAddRelay = async () => {
    const trimmed = newRelayUrl.trim();
    if (!trimmed || (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://"))) {
      return;
    }
    setActionBusy("add_relay");
    try {
      const updated = await invoke<string[]>("add_mesh_relay", { relayUrl: trimmed });
      setNewRelayUrl("");
      setShowAddRelay(false);
      await fetchDiagnostics();
      probeAllRelays(updated);
    } catch (err: any) {
      console.error("Failed to add relay:", err);
    } finally {
      setActionBusy(null);
    }
  };

  // Handler: Remove a relay from mesh
  const handleRemoveRelay = async (relayUrl: string) => {
    setActionBusy(`remove_${relayUrl}`);
    try {
      const updated = await invoke<string[]>("remove_mesh_relay", { relayUrl });
      await fetchDiagnostics();
      probeAllRelays(updated);
    } catch (err: any) {
      console.error("Failed to remove relay:", err);
    } finally {
      setActionBusy(null);
    }
  };

  // Handler: Reset default relays
  const handleResetRelays = async () => {
    setActionBusy("reset_relays");
    try {
      const resetList = await invoke<string[]>("reset_mesh_relays");
      await fetchDiagnostics();
      probeAllRelays(resetList);
    } catch (err: any) {
      console.error("Failed to reset relays:", err);
    } finally {
      setActionBusy(null);
    }
  };

  // Handler: Initialize Vault Identity
  const handleInitializeIdentity = async () => {
    setActionBusy("init_did");
    try {
      await invoke("generate_did");
      await fetchDiagnostics();
      onNavigateTab?.("enclave");
    } catch (err: any) {
      console.error("Failed to generate identity:", err);
    } finally {
      setActionBusy(null);
    }
  };

  // Handler: Export Encrypted Backup
  const handleExportBackup = async () => {
    if (!backupPassword) {
      setBackupError("Please enter an encryption password.");
      return;
    }
    if (backupPassword !== backupConfirmPassword) {
      setBackupError("Passwords do not match.");
      return;
    }
    setBackupLoading(true);
    setBackupError(null);
    setBackupStatus(null);

    try {
      const backupBytes = await invoke<number[]>("create_vault_backup", {
        password: backupPassword,
      });

      const selectedPath = await save({
        defaultPath: "iyou_home_backup.iyoubackup",
        filters: [{ name: "iyou Backup", extensions: ["iyoubackup"] }],
      });

      if (selectedPath) {
        await invoke("write_binary_file", {
          path: selectedPath,
          contents: backupBytes,
        });
        await invoke("record_backup_timestamp");
        setBackupStatus("✅ Encrypted backup exported successfully!");
        setBackupPassword("");
        setBackupConfirmPassword("");
        await fetchDiagnostics();
        setTimeout(() => {
          setShowBackupModal(false);
          setBackupStatus(null);
        }, 1500);
      }
    } catch (err: any) {
      setBackupError(`Export failed: ${err.toString()}`);
    } finally {
      setBackupLoading(false);
    }
  };

  // Calculation of Responsive Relay Count
  const configuredRelays = diagnostics?.relay_gossip_mesh?.relays || [];
  const connectedRelaysCount = Object.values(relayResults).filter(
    (r) => r.status === "connected",
  ).length;
  const isRelayMeshFulfilled = diagnostics?.relay_gossip_mesh?.mesh_ready ?? (configuredRelays.length >= 3);

  // Capability Fulfillment Checklist States
  const isKeyCustodyFulfilled = diagnostics?.key_custody?.initialized ?? false;
  const isNostrFulfilled = diagnostics?.local_ingress_relay?.running ?? false;
  const isBlossomFulfilled = diagnostics?.local_media_server?.running ?? false;
  const isBackupFulfilled = diagnostics?.encrypted_backups?.is_fresh ?? false;

  const fulfilledCount = [
    isKeyCustodyFulfilled,
    isNostrFulfilled,
    isBlossomFulfilled,
    isRelayMeshFulfilled,
    isBackupFulfilled,
  ].filter(Boolean).length;

  const totalChecks = 5;
  const sovereigntyScorePct = Math.round((fulfilledCount / totalChecks) * 100);

  const getScoreBadge = () => {
    if (fulfilledCount === 5) {
      return {
        label: "5/5 Sovereign Enclave",
        color: "#059669",
        bg: "#ecfdf5",
        border: "#a7f3d0",
        icon: "🛡️",
      };
    }
    if (fulfilledCount >= 3) {
      return {
        label: `${fulfilledCount}/5 Partial Autonomy`,
        color: "#d97706",
        bg: "#fffbeb",
        border: "#fde68a",
        icon: "⚠️",
      };
    }
    return {
      label: `${fulfilledCount}/5 Custodial Exposure`,
      color: "#dc2626",
      bg: "#fef2f2",
      border: "#fecaca",
      icon: "🚨",
    };
  };

  const badge = getScoreBadge();

  if (!isExpanded) {
    return (
      <div
        style={{
          marginBottom: "1.25rem",
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "10px",
          padding: "0.55rem 1rem",
          boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.05)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.6rem",
          minHeight: "40px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ fontSize: "1rem" }}>
            {fulfilledCount === 5 ? "🟢" : "🟡"}
          </span>
          <span style={{ fontWeight: 600, fontSize: "0.88rem", color: "#0f172a" }}>
            Sovereignty Health: {fulfilledCount}/{totalChecks} Checks Operational
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.2rem 0.55rem",
              borderRadius: "999px",
              fontSize: "0.75rem",
              fontWeight: 700,
              color: badge.color,
              background: badge.bg,
              border: `1px solid ${badge.border}`,
            }}
          >
            <span>{badge.icon}</span>
            <span>{badge.label}</span>
          </div>

          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
              padding: "0.3rem 0.65rem",
              fontSize: "0.78rem",
              fontWeight: 600,
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#f8fafc",
              color: "#334155",
              cursor: "pointer",
            }}
          >
            Expand Diagnostic Matrix ▾
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        marginBottom: "1.75rem",
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "12px",
        padding: "1.25rem",
        boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.05)",
      }}
    >
      {/* Panel Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.75rem",
          marginBottom: "1rem",
          paddingBottom: "0.85rem",
          borderBottom: "1px solid #f1f5f9",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ fontSize: "1.4rem" }}>🛡️</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: "1.05rem", color: "#0f172a" }}>
              Private Enclave Sovereignty HUD
            </div>
            <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "0.1rem" }}>
              Hardware & local daemon capability matrix · Evaluated locally in-memory
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.65rem" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.3rem 0.75rem",
              borderRadius: "999px",
              fontSize: "0.82rem",
              fontWeight: 700,
              color: badge.color,
              background: badge.bg,
              border: `1px solid ${badge.border}`,
            }}
          >
            <span>{badge.icon}</span>
            <span>{badge.label}</span>
          </div>

          <button
            type="button"
            onClick={fetchDiagnostics}
            disabled={loading || probingRelays}
            style={{
              padding: "0.35rem 0.75rem",
              fontSize: "0.8rem",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#f8fafc",
              color: "#475569",
              cursor: "pointer",
            }}
          >
            {loading || probingRelays ? "Scanning…" : "🔄 Refresh"}
          </button>

          <button
            type="button"
            onClick={() => setIsExpanded(false)}
            style={{
              padding: "0.35rem 0.75rem",
              fontSize: "0.8rem",
              fontWeight: 600,
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: "#f8fafc",
              color: "#334155",
              cursor: "pointer",
            }}
          >
            Collapse ▴
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: "1rem",
            padding: "0.65rem 0.85rem",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            borderRadius: "6px",
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      )}

      {/* Capability Checklist Matrix */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
        {/* CHECK 1: Key Custody */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.85rem 1rem",
            borderRadius: "8px",
            background: isKeyCustodyFulfilled ? "#f0fdf4" : "#f8fafc",
            border: `1px solid ${isKeyCustodyFulfilled ? "#bbf7d0" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "1.25rem" }}>
              {isKeyCustodyFulfilled ? "🟢" : "⚪"}
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.92rem", color: "#1e293b" }}>
                Key Custody & Hardware Air-Gap
              </div>
              <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "0.15rem" }}>
                {isKeyCustodyFulfilled ? (
                  <>
                    Active: <code style={{ color: "#047857" }}>{truncateDid(diagnostics?.key_custody?.active_did || "")}</code> · Level 0 Anchor immutable
                  </>
                ) : (
                  "No sovereign identity generated yet · Root seed uninitialized"
                )}
              </div>
            </div>
          </div>

          <div>
            {isKeyCustodyFulfilled ? (
              <span
                style={{
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  color: "#047857",
                  background: "#dcfce7",
                  padding: "0.2rem 0.55rem",
                  borderRadius: "4px",
                }}
              >
                ✓ Enclave Active
              </span>
            ) : (
              <button
                type="button"
                onClick={handleInitializeIdentity}
                disabled={actionBusy === "init_did"}
                style={{
                  fontSize: "0.8rem",
                  padding: "0.35rem 0.8rem",
                  background: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                }}
              >
                {actionBusy === "init_did" ? "Generating…" : "Initialize Identity"}
              </button>
            )}
          </div>
        </div>

        {/* CHECK 2: Local Ingress Relay (127.0.0.1:9003) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.85rem 1rem",
            borderRadius: "8px",
            background: isNostrFulfilled ? "#f0fdf4" : "#f8fafc",
            border: `1px solid ${isNostrFulfilled ? "#bbf7d0" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "1.25rem" }}>
              {isNostrFulfilled ? "🟢" : "⚪"}
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.92rem", color: "#1e293b" }}>
                Local Ingress Relay (Nostr NIP-01)
              </div>
              <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "0.15rem" }}>
                {isNostrFulfilled ? (
                  <>
                    Listening on <code style={{ color: "#047857" }}>127.0.0.1:9003</code> · SQLite Event Cache: {diagnostics?.local_ingress_relay?.events_count ?? 0} events
                  </>
                ) : (
                  "Offline · Timeline events and articles require loopback relay daemon"
                )}
              </div>
            </div>
          </div>

          <div>
            {isNostrFulfilled ? (
              <span
                style={{
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  color: "#047857",
                  background: "#dcfce7",
                  padding: "0.2rem 0.55rem",
                  borderRadius: "4px",
                }}
              >
                ✓ Listening :9003
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleStartService("Nostr")}
                disabled={actionBusy === "Nostr"}
                style={{
                  fontSize: "0.8rem",
                  padding: "0.35rem 0.8rem",
                  background: "#4338ca",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                }}
              >
                {actionBusy === "Nostr" ? "Starting…" : "Start Local Relay"}
              </button>
            )}
          </div>
        </div>

        {/* CHECK 3: Local Media Server (Blossom BUD-01 on 127.0.0.1:9002) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.85rem 1rem",
            borderRadius: "8px",
            background: isBlossomFulfilled ? "#f0fdf4" : "#f8fafc",
            border: `1px solid ${isBlossomFulfilled ? "#bbf7d0" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "1.25rem" }}>
              {isBlossomFulfilled ? "🟢" : "⚪"}
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.92rem", color: "#1e293b" }}>
                Local Media Server (Blossom BUD-01 PDS)
              </div>
              <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "0.15rem" }}>
                {isBlossomFulfilled ? (
                  <>
                    Listening on <code style={{ color: "#047857" }}>http://127.0.0.1:9002</code> · Stored Blobs: {diagnostics?.local_media_server?.blobs_count ?? 0}
                  </>
                ) : (
                  "Offline · Personal Data Store blob storage not bound to loopback"
                )}
              </div>
            </div>
          </div>

          <div>
            {isBlossomFulfilled ? (
              <span
                style={{
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  color: "#047857",
                  background: "#dcfce7",
                  padding: "0.2rem 0.55rem",
                  borderRadius: "4px",
                }}
              >
                ✓ Listening :9002
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleStartService("Blossom")}
                disabled={actionBusy === "Blossom"}
                style={{
                  fontSize: "0.8rem",
                  padding: "0.35rem 0.8rem",
                  background: "#4338ca",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                }}
              >
                {actionBusy === "Blossom" ? "Starting…" : "Start Local Blossom"}
              </button>
            )}
          </div>
        </div>

        {/* CHECK 4: Relay Gossip Mesh (>= 3 independent Nostr relays) */}
        <div
          style={{
            padding: "0.85rem 1rem",
            borderRadius: "8px",
            background: isRelayMeshFulfilled ? "#f0fdf4" : "#f8fafc",
            border: `1px solid ${isRelayMeshFulfilled ? "#bbf7d0" : "#e2e8f0"}`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "0.5rem",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <span style={{ fontSize: "1.25rem" }}>
                {isRelayMeshFulfilled ? "🟢" : "⚪"}
              </span>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.92rem", color: "#1e293b" }}>
                  Relay Gossip Mesh (≥ 3 Independent Relays)
                </div>
                <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "0.15rem" }}>
                  {probingRelays
                    ? "Probing relay latencies…"
                    : `${connectedRelaysCount} of ${configuredRelays.length} configured relays active and responding`}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <button
                type="button"
                onClick={() => setShowAddRelay(!showAddRelay)}
                style={{
                  fontSize: "0.78rem",
                  padding: "0.3rem 0.65rem",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  cursor: "pointer",
                  color: "#334155",
                }}
              >
                {showAddRelay ? "Cancel" : "+ Add Relay"}
              </button>

              <button
                type="button"
                onClick={() => probeAllRelays(configuredRelays)}
                disabled={probingRelays}
                style={{
                  fontSize: "0.78rem",
                  padding: "0.3rem 0.65rem",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  cursor: "pointer",
                  color: "#334155",
                }}
              >
                {probingRelays ? "Testing…" : "⚡ Ping Mesh"}
              </button>
            </div>
          </div>

          {/* Inline Add Relay Input */}
          {showAddRelay && (
            <div
              style={{
                marginTop: "0.75rem",
                padding: "0.65rem",
                background: "#ffffff",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                display: "flex",
                gap: "0.5rem",
              }}
            >
              <input
                type="text"
                value={newRelayUrl}
                onChange={(e) => setNewRelayUrl(e.target.value)}
                placeholder="wss://relay.example.com"
                style={{
                  flex: 1,
                  padding: "0.4rem 0.6rem",
                  fontSize: "0.82rem",
                  borderRadius: "4px",
                  border: "1px solid #cbd5e1",
                }}
              />
              <button
                type="button"
                onClick={handleAddRelay}
                disabled={!newRelayUrl.trim() || actionBusy === "add_relay"}
                style={{
                  padding: "0.4rem 0.8rem",
                  fontSize: "0.8rem",
                  background: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {actionBusy === "add_relay" ? "Adding…" : "Add"}
              </button>
            </div>
          )}

          {/* Configured Relays Pills */}
          <div
            style={{
              marginTop: "0.75rem",
              display: "flex",
              flexWrap: "wrap",
              gap: "0.45rem",
            }}
          >
            {configuredRelays.map((url) => {
              const probe = relayResults[url];
              const isConnected = probe?.status === "connected";
              const isConnecting = probe?.status === "connecting";

              return (
                <div
                  key={url}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    padding: "0.25rem 0.55rem",
                    borderRadius: "6px",
                    background: isConnected
                      ? "#dcfce7"
                      : isConnecting
                        ? "#fef3c7"
                        : "#fee2e2",
                    border: `1px solid ${
                      isConnected
                        ? "#86efac"
                        : isConnecting
                          ? "#fde047"
                          : "#fca5a5"
                    }`,
                    fontSize: "0.75rem",
                    fontFamily: "monospace",
                    color: isConnected
                      ? "#166534"
                      : isConnecting
                        ? "#854d0e"
                        : "#991b1b",
                  }}
                >
                  <span>{isConnected ? "●" : isConnecting ? "○" : "✕"}</span>
                  <span>{url}</span>
                  {probe?.latencyMs !== undefined && (
                    <span style={{ opacity: 0.75 }}>({probe.latencyMs}ms)</span>
                  )}
                  {configuredRelays.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveRelay(url)}
                      title="Remove relay"
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        padding: "0 0.15rem",
                        color: "inherit",
                        fontSize: "0.75rem",
                        boxShadow: "none",
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}

            {configuredRelays.length < 3 && (
              <button
                type="button"
                onClick={handleResetRelays}
                disabled={actionBusy === "reset_relays"}
                style={{
                  fontSize: "0.75rem",
                  padding: "0.2rem 0.5rem",
                  background: "#eff6ff",
                  border: "1px solid #bfdbfe",
                  color: "#1d4ed8",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                Restore Default Mesh
              </button>
            )}
          </div>
        </div>

        {/* CHECK 5: Encrypted Backups (< 30 days) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.85rem 1rem",
            borderRadius: "8px",
            background: isBackupFulfilled ? "#f0fdf4" : "#f8fafc",
            border: `1px solid ${isBackupFulfilled ? "#bbf7d0" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "1.25rem" }}>
              {isBackupFulfilled ? "🟢" : "⚪"}
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.92rem", color: "#1e293b" }}>
                Encrypted Vault Backups (Freshness &lt; 30 Days)
              </div>
              <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "0.15rem" }}>
                {isBackupFulfilled ? (
                  diagnostics?.encrypted_backups?.days_since_backup === 0 ? (
                    "Backup exported today · Password-encrypted .iyoubackup archive"
                  ) : (
                    `Last export: ${diagnostics?.encrypted_backups?.days_since_backup} days ago (Optimal freshness)`
                  )
                ) : diagnostics?.encrypted_backups?.last_backup_at === 0 ? (
                  "No archive exported yet · Export encrypted snapshot for disaster recovery"
                ) : (
                  `Stale archive (> ${diagnostics?.encrypted_backups?.days_since_backup ?? 30} days old) · Create fresh snapshot`
                )}
              </div>
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowBackupModal(true)}
              style={{
                fontSize: "0.8rem",
                padding: "0.35rem 0.8rem",
                background: isBackupFulfilled ? "#f1f5f9" : "#059669",
                color: isBackupFulfilled ? "#334155" : "#ffffff",
                border: isBackupFulfilled ? "1px solid #cbd5e1" : "none",
                borderRadius: "6px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {isBackupFulfilled ? "Export New Snapshot" : "Export Backup"}
            </button>
          </div>
        </div>
      </div>

      {/* Footer Info / Zero-Vanity Notice */}
      <div
        style={{
          marginTop: "1rem",
          paddingTop: "0.75rem",
          borderTop: "1px solid #f1f5f9",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "0.75rem",
          color: "#94a3b8",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <span>
          🔒 Evaluated inside your private enclave · Zero telemetry or external scoring
        </span>
        <span>
          Overall Sovereignty: <strong>{sovereigntyScorePct}%</strong>
        </span>
      </div>

      {/* Quick Export Backup Modal */}
      {showBackupModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(15, 23, 42, 0.75)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 999,
            padding: "1rem",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              width: "100%",
              maxWidth: "460px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)",
              border: "1px solid #e2e8f0",
              padding: "1.25rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "0.85rem",
              }}
            >
              <div style={{ fontWeight: 700, fontSize: "1.05rem", color: "#0f172a" }}>
                🔒 Export Sovereign Vault Backup
              </div>
              <button
                type="button"
                onClick={() => setShowBackupModal(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#64748b",
                  fontSize: "1.1rem",
                  cursor: "pointer",
                  boxShadow: "none",
                  padding: "0.2rem",
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ fontSize: "0.82rem", color: "#64748b", marginBottom: "1rem" }}>
              Generates a password-encrypted <code>.iyoubackup</code> snapshot of all your local personas, contacts, and sovereign settings.
            </div>

            {backupStatus && (
              <div
                style={{
                  marginBottom: "0.85rem",
                  padding: "0.6rem 0.75rem",
                  background: "#ecfdf5",
                  color: "#065f46",
                  borderRadius: "6px",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                }}
              >
                {backupStatus}
              </div>
            )}

            {backupError && (
              <div
                style={{
                  marginBottom: "0.85rem",
                  padding: "0.6rem 0.75rem",
                  background: "#fef2f2",
                  color: "#991b1b",
                  borderRadius: "6px",
                  fontSize: "0.82rem",
                }}
              >
                {backupError}
              </div>
            )}

            <div style={{ marginBottom: "0.75rem" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: "#334155",
                  marginBottom: "0.25rem",
                }}
              >
                Backup Encryption Password
              </label>
              <input
                type="password"
                value={backupPassword}
                onChange={(e) => setBackupPassword(e.target.value)}
                placeholder="Enter strong password"
                style={{
                  width: "100%",
                  padding: "0.55rem 0.7rem",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.88rem",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ marginBottom: "1.25rem" }}>
              <label
                style={{
                  display: "block",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  color: "#334155",
                  marginBottom: "0.25rem",
                }}
              >
                Confirm Password
              </label>
              <input
                type="password"
                value={backupConfirmPassword}
                onChange={(e) => setBackupConfirmPassword(e.target.value)}
                placeholder="Repeat password"
                style={{
                  width: "100%",
                  padding: "0.55rem 0.7rem",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.88rem",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                type="button"
                onClick={() => setShowBackupModal(false)}
                disabled={backupLoading}
                style={{
                  padding: "0.45rem 0.9rem",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#f8fafc",
                  color: "#475569",
                  cursor: "pointer",
                  fontSize: "0.85rem",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExportBackup}
                disabled={backupLoading || !backupPassword || !backupConfirmPassword}
                style={{
                  padding: "0.45rem 1.1rem",
                  borderRadius: "6px",
                  border: "none",
                  background: "#059669",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                  cursor:
                    backupLoading || !backupPassword || !backupConfirmPassword
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    backupLoading || !backupPassword || !backupConfirmPassword ? 0.6 : 1,
                }}
              >
                {backupLoading ? "Encrypting & Exporting…" : "Export Backup (.iyoubackup)"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
