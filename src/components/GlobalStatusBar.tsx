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
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Profile } from "../lib/types";

type ServiceStatus = "running" | "stopped" | "starting";

interface GlobalStatusBarProps {
  onNavigateEnclave: () => void;
}

function truncateDid(did: string, lead = 20, tail = 6): string {
  if (!did || did.length <= lead + tail + 3) return did || "";
  return `${did.slice(0, lead)}...${did.slice(-tail)}`;
}

export default function GlobalStatusBar({ onNavigateEnclave }: GlobalStatusBarProps) {
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>({});
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [copiedDid, setCopiedDid] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number>(0);

  const pollStatuses = useCallback(async () => {
    try {
      const s = await invoke<Record<string, ServiceStatus>>("get_service_statuses");
      setStatuses(s);
    } catch {
      // silent — status bar is best-effort
    }
  }, []);

  const loadProfile = useCallback(async () => {
    try {
      const [profiles, did] = await Promise.all([
        invoke<Profile[]>("list_profiles"),
        invoke<string | null>("get_active_did"),
      ]);
      if (did && profiles) {
        const match = profiles.find((p) => p.did === did);
        setActiveProfile(match || null);
      }
    } catch {
      // silent
    }
  }, []);

  const loadSyncStatus = useCallback(async () => {
    try {
      const s = await invoke<{ last_synced_at: number }>("get_sync_status");
      setLastSyncedAt(s.last_synced_at);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    pollStatuses();
    loadProfile();
    loadSyncStatus();
    const interval = setInterval(() => {
      pollStatuses();
      loadSyncStatus();
    }, 10_000);
    return () => clearInterval(interval);
  }, [pollStatuses, loadProfile, loadSyncStatus]);

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
    const s = statuses[name];
    if (name === "SigBridge") return "var(--color-success)";
    if (s === "running") return "var(--color-success)";
    if (s === "starting") return "var(--color-warning)";
    return "#9ca3af";
  };

  const dotLabel = (name: string): string => {
    const s = statuses[name];
    if (name === "SigBridge") return `${name} — always active`;
    return `${name} — ${s || "unknown"}`;
  };

  const personaLabel = activeProfile
    ? activeProfile.level === 0
      ? "Anchor (L0)"
      : `${activeProfile.profile_name} (L${activeProfile.level})`
    : "No identity";

  const personaIcon = activeProfile && activeProfile.level === 0 ? "\uD83D\uDEE1\uFE0F" : "\uD83D\uDC64";

  const formatSyncLabel = (ts: number): string => {
    if (ts === 0) return "Not synced";
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "Synced just now";
    if (diff < 3600) return `Synced ${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `Synced ${Math.floor(diff / 3600)}h ago`;
    return `Synced ${Math.floor(diff / 86400)}d ago`;
  };

  return (
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

      {/* Right cluster: Active persona pill */}
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
              {copiedDid ? "\u2713" : "\uD83D\uDCCB"}
            </span>
          </>
        )}
      </button>
    </div>
  );
}
