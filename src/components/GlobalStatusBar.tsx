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
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Profile, UpdateMetadata, UpdatePreferences } from "../lib/types";
import QuickDispatchModal from "./QuickDispatchModal";
import UpdateVettingModal from "./updater/UpdateVettingModal";

type ServiceStatus = "running" | "stopped" | "starting";

interface GlobalStatusBarProps {
  onNavigateEnclave: () => void;
  activeProfile?: Profile | null;
  setActiveProfile?: (profile: Profile | null) => void;
}

function truncateDid(did: string, lead = 16): string {
  if (!did) return "";
  if (did.length <= lead) return did;
  return `${did.slice(0, lead)}...`;
}

export default function GlobalStatusBar({
  onNavigateEnclave,
  activeProfile: propActiveProfile,
}: GlobalStatusBarProps) {
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>({});
  const [localActiveProfile, setLocalActiveProfile] = useState<Profile | null>(null);
  const activeProfile = propActiveProfile !== undefined ? propActiveProfile : localActiveProfile;
  const [copiedDid, setCopiedDid] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number>(0);
  const [isDispatchOpen, setIsDispatchOpen] = useState(false);

  // Update check states
  const [availableUpdate, setAvailableUpdate] = useState<UpdateMetadata | null>(null);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);

  const pollStatuses = useCallback(async () => {
    try {
      const s = await invoke<Record<string, ServiceStatus>>("get_service_statuses");
      setStatuses(s);
    } catch {
      // silent — status bar is best-effort
    }
  }, []);

  const loadProfile = useCallback(async () => {
    if (propActiveProfile !== undefined) return;
    try {
      const active = await invoke<Profile | null | undefined>("get_active_profile");
      if (active && (active.profile_name || active.did || active.profile_id)) {
        setLocalActiveProfile(active);
        return;
      }
    } catch {
      // fall through to list_profiles
    }
    try {
      const [profiles, did] = await Promise.all([
        invoke<Profile[]>("list_profiles"),
        invoke<string | null>("get_active_did"),
      ]);
      if (profiles && profiles.length > 0) {
        const match =
          (did ? profiles.find((p) => p.did === did) : null) ||
          profiles.find((p) => p.active === true) ||
          profiles.find((p) => p.level === 1) ||
          profiles[0];
        setLocalActiveProfile(match || null);
      }
    } catch {
      // silent
    }
  }, [propActiveProfile]);

  const loadSyncStatus = useCallback(async () => {
    try {
      const s = await invoke<{ last_synced_at: number }>("get_sync_status");
      setLastSyncedAt(s.last_synced_at);
    } catch {
      // silent
    }
  }, []);

  const checkUpdates = useCallback(async (force = false) => {
    try {
      const meta = await invoke<UpdateMetadata | null>("check_for_update_vetting", { force });
      if (meta) {
        setAvailableUpdate(meta);
        if (force) setIsUpdateModalOpen(true);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    pollStatuses();
    loadProfile();
    loadSyncStatus();
    checkUpdates(false);

    const interval = setInterval(() => {
      pollStatuses();
      loadSyncStatus();
    }, 10_000);

    const unlistenPromise = listen("app://check-updates", () => {
      checkUpdates(true);
    });

    return () => {
      clearInterval(interval);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [pollStatuses, loadProfile, loadSyncStatus, checkUpdates]);

  const handleCopyDid = async () => {
    if (!activeProfile?.did) return;
    try {
      await writeText(activeProfile.did);
    } catch {
      try {
        await navigator.clipboard.writeText(activeProfile.did);
      } catch {
        return;
      }
    }
    setCopiedDid(true);
    setTimeout(() => setCopiedDid(false), 2000);
  };

  const dotColor = (name: string): string => {
    const s = statuses?.[name];
    if (name === "SigBridge") return "var(--color-success)";
    if (s === "running") return "var(--color-success)";
    if (s === "starting") return "var(--color-warning)";
    return "#9ca3af";
  };

  const dotLabel = (name: string): string => {
    const s = statuses?.[name];
    if (name === "SigBridge") return `${name} — always active`;
    return `${name} — ${s || "unknown"}`;
  };

  const personaLabel = activeProfile
    ? activeProfile.level === 0
      ? "Anchor (L0)"
      : `${activeProfile.name || activeProfile.profile_name} (${activeProfile.level === 1 ? "L1" : "L2"})`
    : "Loading…";

  const personaIcon = activeProfile
    ? activeProfile.level === 0
      ? "🛡️"
      : activeProfile.level === 1
        ? "👤"
        : "🎭"
    : "⏳";

  const formatSyncLabel = (ts: number): string => {
    if (ts === 0) return "Not synced";
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "Synced just now";
    if (diff < 3600) return `Synced ${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `Synced ${Math.floor(diff / 3600)}h ago`;
    return `Synced ${Math.floor(diff / 86400)}d ago`;
  };

  const handleSkipVersion = async (version: string) => {
    try {
      const prefs = await invoke<UpdatePreferences>("get_update_preferences");
      prefs.ignored_version = version;
      await invoke("set_update_preferences", { prefs });
      setAvailableUpdate(null);
    } catch (err) {
      console.error("Failed to skip update version:", err);
    }
  };

  return (
    <>
      <div className="global-status-bar">
        {/* Left cluster: Wordmark */}
        <button
          type="button"
          className="status-bar-wordmark"
          onClick={onNavigateEnclave}
        >
          <span className="wordmark-text">iyou_home</span>
          <span className="wordmark-badge">v2.0 · Enclave Active</span>
        </button>

        {/* Center cluster: Daemon indicators + sync */}
        <div className="status-bar-daemons">
          {["SigBridge", "Nostr", "Blossom"].map((name) => (
            <span
              key={name}
              className="daemon-indicator"
              title={dotLabel(name)}
            >
              <span
                className="daemon-dot"
                style={{ backgroundColor: dotColor(name) }}
              />
              <span className="daemon-label">{name}</span>
            </span>
          ))}
          <span
            className="daemon-indicator sync-indicator"
            title={formatSyncLabel(lastSyncedAt)}
            style={{ marginLeft: "0.5rem", opacity: 0.85 }}
          >
            <span
              className="daemon-dot"
              style={{
                backgroundColor:
                  lastSyncedAt === 0
                    ? "#9ca3af"
                    : (Date.now() / 1000 - lastSyncedAt) < 300
                      ? "var(--color-success)"
                      : "var(--color-warning)",
              }}
            />
            <span className="daemon-label">Sync</span>
          </span>
        </div>

        {/* Right cluster: Update badge + Quick Dispatch trigger + Active persona pill */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          {availableUpdate && (
            <button
              type="button"
              onClick={() => setIsUpdateModalOpen(true)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.3rem",
                padding: "0.25rem 0.65rem",
                background: "#ecfdf5",
                color: "#047857",
                border: "1px solid #a7f3d0",
                borderRadius: "999px",
                fontSize: "0.75rem",
                fontWeight: 700,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              title="Click to cryptographically inspect and install update"
            >
              <span>🚀</span>
              <span>Update v{availableUpdate.target_version} Available</span>
            </button>
          )}

          <button
            type="button"
            className="status-bar-dispatch-btn"
            onClick={() => setIsDispatchOpen(true)}
            title="Quick Dispatcher (Note, Media Drop, Civic Poll)"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.35rem 0.8rem",
              background: "linear-gradient(135deg, #4338ca 0%, #312e81 100%)",
              color: "#ffffff",
              border: "1px solid rgba(199, 210, 254, 0.4)",
              borderRadius: "999px",
              fontSize: "0.78rem",
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
              transition: "transform 0.1s, opacity 0.15s",
            }}
          >
            <span>✍️</span>
            <span>Dispatch</span>
          </button>

          <button
            type="button"
            className="status-bar-persona"
            onClick={onNavigateEnclave}
            title={activeProfile?.did || "No identity"}
          >
            <span className="persona-icon">{personaIcon}</span>
            <span className="persona-label">{personaLabel}</span>
            {activeProfile?.did && (
              <>
                <span className="persona-did">{truncateDid(activeProfile.did)}</span>
                <span
                  className="persona-copy"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCopyDid();
                  }}
                  title="Copy DID"
                >
                  {copiedDid ? "✓" : "📋"}
                </span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Quick Dispatch Modal */}
      <QuickDispatchModal
        isOpen={isDispatchOpen}
        onClose={() => setIsDispatchOpen(false)}
        activeProfile={activeProfile}
      />

      {/* Cryptographic Release Vetting Modal */}
      <UpdateVettingModal
        isOpen={isUpdateModalOpen}
        onClose={() => setIsUpdateModalOpen(false)}
        updateMetadata={availableUpdate}
        onInstallComplete={() => setAvailableUpdate(null)}
        onSkipVersion={handleSkipVersion}
      />
    </>
  );
}
