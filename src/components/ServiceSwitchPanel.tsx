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

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import BlossomBrowser from "./BlossomBrowser";
import SovereignFootprint from "./SovereignFootprint";

type ServiceStatus = "running" | "stopped" | "starting";

interface SyncStatus {
  last_synced_at: number;
  local_notes_count: number;
  local_blobs_count: number;
}

interface ServiceInfo {
  name: string;
  port: number;
  description: string;
  alwaysOn?: boolean;
}

const SERVICES: ServiceInfo[] = [
  {
    name: "SigBridge",
    port: 9001,
    alwaysOn: true,
    description: "Routes external signing requests to your local vault",
  },
  {
    name: "Blossom",
    port: 9002,
    description: "Content-addressed media blob storage",
  },
  {
    name: "Nostr",
    port: 9003,
    description: "Local personal relay for timeline events and articles",
  },
  {
    name: "Chat",
    port: 5222,
    description: "End-to-end encrypted mesh messaging daemon",
  },
];

const AUTO_START_DEFAULTS: Record<string, boolean> = {
  Blossom: true,
  Nostr: true,
  Chat: true,
};

export default function ServiceSwitchPanel() {
  const [serviceStatus, setServiceStatus] = useState<
    Record<string, ServiceStatus>
  >({
    SigBridge: "running",
    ...SERVICES.filter((s) => !s.alwaysOn).reduce(
      (acc, s) => {
        acc[s.name] = "stopped";
        return acc;
      },
      {} as Record<string, ServiceStatus>,
    ),
  });
  const [autoStart, setAutoStart] = useState<Record<string, boolean>>({});
  const [showTechDetails, setShowTechDetails] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const [settings, statuses] = await Promise.all([
          invoke<Record<string, boolean>>("get_auto_start_settings"),
          invoke<Record<string, ServiceStatus>>("get_service_statuses"),
        ]);
        setAutoStart((prev) => {
          const merged = { ...prev };
          for (const svc of SERVICES) {
            if (svc.name in settings) {
              merged[svc.name] = settings[svc.name];
            } else if (svc.name in AUTO_START_DEFAULTS) {
              merged[svc.name] = AUTO_START_DEFAULTS[svc.name];
            }
          }
          return merged;
        });
        setServiceStatus((prev) => ({ ...prev, ...statuses }));
      } catch (error) {
        console.error("Failed to load startup settings:", error);
      }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    const loadSyncStatus = async () => {
      try {
        const status = await invoke<SyncStatus>("get_sync_status");
        setSyncStatus(status);
      } catch {
        // silent — sync status is best-effort
      }
    };
    loadSyncStatus();
  }, []);

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      await invoke("trigger_manual_sync");
      const status = await invoke<SyncStatus>("get_sync_status");
      setSyncStatus(status);
    } catch (error) {
      console.error("Sync failed:", error);
    } finally {
      setSyncing(false);
    }
  };

  const formatSyncTime = (ts: number): string => {
    if (ts === 0) return "Never";
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts * 1000).toLocaleDateString();
  };

  const handleToggleService = async (name: string) => {
    const currentStatus = serviceStatus[name];
    const action = currentStatus === "running" ? "stop" : "start";

    try {
      const newStatus = await invoke<ServiceStatus>("toggle_service", {
        name,
        action,
      });
      setServiceStatus((prev) => ({ ...prev, [name]: newStatus }));
    } catch (error) {
      console.error(`Failed to toggle service ${name}:`, error);
    }
  };

  const handleAutoStartToggle = async (name: string, enabled: boolean) => {
    setAutoStart((prev) => ({ ...prev, [name]: enabled }));
    try {
      await invoke("set_auto_start", { name, enabled });
    } catch (error) {
      console.error(`Failed to set auto-start for ${name}:`, error);
    }
  };

  return (
    <>
      <h2>Services</h2>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {SERVICES.map((svc) => {
          const status = serviceStatus[svc.name] || "stopped";
          return (
            <div
              key={svc.name}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "1rem 1.25rem",
                borderRadius: "8px",
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
                flexWrap: "wrap",
                gap: "0.75rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <span
                  className={`status-light ${status}`}
                  title={status}
                />
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                    {svc.name}
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "#6b7280", marginTop: "0.15rem" }}>
                    {svc.description}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                {svc.alwaysOn ? (
                  <span className="always-on-badge">Always On</span>
                ) : (
                  <>
                    <label className="autostart-toggle">
                      <input
                        type="checkbox"
                        checked={
                          autoStart[svc.name] ??
                          AUTO_START_DEFAULTS[svc.name] ??
                          false
                        }
                        onChange={(e) =>
                          handleAutoStartToggle(svc.name, e.target.checked)
                        }
                      />
                      Autostart
                    </label>
                    <button
                      onClick={() => handleToggleService(svc.name)}
                      style={{ fontSize: "0.85rem" }}
                    >
                      {status === "running" ? "Stop" : "Start"}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Sync to Home Status Card */}
      <div
        style={{
          marginTop: "1.25rem",
          padding: "1rem 1.25rem",
          borderRadius: "8px",
          background: "#f0fdf4",
          border: "1px solid #bbf7d0",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "0.75rem",
          }}
        >
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
              {"\uD83D\uDD04"} Sync to Home
            </div>
            <div
              style={{
                fontSize: "0.8rem",
                color: "#6b7280",
                marginTop: "0.15rem",
              }}
            >
              Last Synced: {syncStatus ? formatSyncTime(syncStatus.last_synced_at) : "\u2014"}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <div
              style={{
                fontSize: "0.8rem",
                color: "#4b5563",
                fontFamily: "monospace",
              }}
            >
              Notes: {syncStatus?.local_notes_count ?? 0} | Blobs: {syncStatus?.local_blobs_count ?? 0}
            </div>
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              style={{
                fontSize: "0.85rem",
                opacity: syncing ? 0.6 : 1,
              }}
            >
              {syncing ? "\u23F3 Syncing\u2026" : "\uD83D\uDD04 Sync Now"}
            </button>
          </div>
        </div>
      </div>

      {/* Sovereign Ecosystem Footprint Matrix */}
      <SovereignFootprint />

      {/* Offline Media Vault */}
      <BlossomBrowser />

      {/* Technical Details Disclosure */}
      <div style={{ marginTop: "1.5rem" }}>
        <button
          type="button"
          onClick={() => setShowTechDetails(!showTechDetails)}
          style={{
            background: "none",
            border: "none",
            boxShadow: "none",
            color: "#6b7280",
            fontSize: "0.8rem",
            padding: "0.25rem 0",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "0.3rem",
          }}
        >
          {showTechDetails ? "\u25B2" : "\u25BC"} Technical Details
        </button>
        {showTechDetails && (
          <div
            style={{
              marginTop: "0.5rem",
              padding: "0.75rem 1rem",
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: "6px",
              fontSize: "0.8rem",
              fontFamily: "monospace",
              color: "#4b5563",
            }}
          >
            {SERVICES.map((svc) => (
              <div key={svc.name} style={{ marginBottom: "0.3rem" }}>
                {svc.name} <span style={{ color: "#9ca3af" }}>:{svc.port}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
