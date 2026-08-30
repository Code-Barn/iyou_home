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

import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Profile, UpdateMetadata, UpdatePolicy, UpdatePreferences, UserPreferences } from "../lib/types";
import { DEFAULT_USER_PREFERENCES } from "../lib/types";
import {
  INACTIVITY_TIMEOUT_OPTIONS,
  isValidAppLockPin,
  loadUserPreferences,
  saveUserPreferences,
  sha256Hex,
} from "../lib/appLock";
import {
  DEFAULT_PRF_SALT,
  getOrRegisterPrfSeed,
  webauthnPrfSupported,
} from "../lib/webauthnPrf";
import DevicePairing from "./DevicePairing";
import UpdateVettingModal from "./updater/UpdateVettingModal";

function levelLabel(level: number): string {
  if (level === 0) return "L0 Anchor";
  if (level === 1) return "L1 Public";
  return `L${level} Burner`;
}

export interface KeysManagerProps {
  prefs?: UserPreferences | null;
  onLockSettingsChange?: (next: UserPreferences) => void;
  activeProfile?: Profile | null;
  setActiveProfile?: (profile: Profile | null) => void;
}

export default function KeysManager({
  prefs: propPrefs,
  onLockSettingsChange,
  activeProfile: propActiveProfile,
  setActiveProfile: propSetActiveProfile,
}: KeysManagerProps = {}) {
  const [localActiveDid, setLocalActiveDid] = useState<string | null>(null);
  const [localActiveProfile, setLocalActiveProfile] = useState<Profile | null>(null);
  const activeProfile = propActiveProfile !== undefined ? propActiveProfile : localActiveProfile;
  const activeDid = activeProfile?.did || localActiveDid;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  // App Lock settings
  const [appPrefs, setAppPrefs] = useState<UserPreferences | null>(propPrefs ?? null);
  const [showPinModal, setShowPinModal] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [lockErrorMessage, setLockErrorMessage] = useState<string | null>(null);
  const [lockStatusMessage, setLockStatusMessage] = useState<string | null>(null);
  const [biometricEnrolling, setBiometricEnrolling] = useState(false);

  // Updater settings & rollback
  const [updatePrefs, setUpdatePrefs] = useState<UpdatePreferences>({
    policy: "manual",
    release_channel: "stable",
    custom_manifest_url: null,
    last_checked_at: null,
    ignored_version: null,
  });
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateStatusMessage, setUpdateStatusMessage] = useState<string | null>(null);
  const [vettedUpdate, setVettedUpdate] = useState<UpdateMetadata | null>(null);
  const [showVettingModal, setShowVettingModal] = useState(false);

  const [hasRollback, setHasRollback] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);
  const [rollbackStatusMessage, setRollbackStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    invoke<UpdatePreferences>("get_update_preferences")
      .then((p) => {
        if (p) setUpdatePrefs(p);
      })
      .catch(() => {});
    invoke<boolean>("has_rollback_binary")
      .then(setHasRollback)
      .catch(() => {});
  }, []);

  const handleUpdatePolicyChange = async (policy: UpdatePolicy) => {
    const next: UpdatePreferences = { ...updatePrefs, policy };
    setUpdatePrefs(next);
    try {
      await invoke("set_update_preferences", { prefs: next });
    } catch (e) {
      console.error("Failed to save update policy:", e);
    }
  };

  const handleReleaseChannelChange = async (release_channel: string) => {
    const next: UpdatePreferences = { ...updatePrefs, release_channel };
    setUpdatePrefs(next);
    try {
      await invoke("set_update_preferences", { prefs: next });
    } catch (e) {
      console.error("Failed to save release channel:", e);
    }
  };

  const handleCheckUpdates = async () => {
    setUpdateChecking(true);
    setUpdateStatusMessage(null);
    try {
      const meta = await invoke<UpdateMetadata | null>("check_for_update_vetting", { force: true });
      if (meta) {
        setVettedUpdate(meta);
        setShowVettingModal(true);
      } else {
        setUpdateStatusMessage("✓ Your sovereign node is up to date.");
        setTimeout(() => setUpdateStatusMessage(null), 4000);
      }
    } catch (err: any) {
      setUpdateStatusMessage(`Check failed: ${err?.toString() || "Network unreachable"}`);
    } finally {
      setUpdateChecking(false);
    }
  };

  const handleExecuteRollback = async () => {
    setRollbackLoading(true);
    setRollbackStatusMessage(null);
    try {
      await invoke("rollback_to_previous_binary");
      setRollbackStatusMessage("✅ Binary rolled back successfully! Please restart iyou_home.");
      setShowRollbackConfirm(false);
    } catch (err: any) {
      setRollbackStatusMessage(`Rollback failed: ${err?.toString()}`);
    } finally {
      setRollbackLoading(false);
    }
  };

  useEffect(() => {
    if (propPrefs !== undefined) {
      setAppPrefs(propPrefs);
    } else {
      loadUserPreferences().then(setAppPrefs);
    }
  }, [propPrefs]);

  // Seed reveal modal
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [seedConfirmText, setSeedConfirmText] = useState("");
  const [seedCountdown, setSeedCountdown] = useState(10);
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const [seedAutoDismiss, setSeedAutoDismiss] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Backup password prompt
  const [showBackupPassword, setShowBackupPassword] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupLoading, setBackupLoading] = useState(false);

  // Restore flow
  const [showRestorePassword, setShowRestorePassword] = useState(false);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [pendingRestoreBytes, setPendingRestoreBytes] = useState<number[] | null>(null);

  // Advanced import
  const [importDid, setImportDid] = useState("");
  const [importKey, setImportKey] = useState("");

  // Global Session Revocation
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [revokeSuccessMsg, setRevokeSuccessMsg] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [did, profiles] = await Promise.all([
        invoke<string | null>("get_active_did"),
        invoke<Profile[]>("list_profiles"),
      ]);
      setLocalActiveDid(did);
      if (profiles && profiles.length > 0) {
        const match =
          (did ? profiles.find((p) => p.did === did) : null) ||
          profiles.find((p) => p.active === true) ||
          profiles.find((p) => p.level === 1) ||
          profiles[0];
        setLocalActiveProfile(match || null);
        if (match && propSetActiveProfile) {
          propSetActiveProfile(match);
        }
      }
    } catch (err: any) {
      setError(err.toString());
    }
  }, [propSetActiveProfile]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Cleanup countdown on unmount
  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (seedAutoDismiss) clearTimeout(seedAutoDismiss);
    };
  }, [seedAutoDismiss]);

  const handleCopyDid = async () => {
    if (!activeDid) return;
    try {
      await writeText(activeDid);
    } catch {
      try {
        await navigator.clipboard.writeText(activeDid);
      } catch (e: any) {
        setError(`Clipboard copy failed: ${e.toString()}`);
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportDocument = async () => {
    if (!activeDid) return;
    setError(null);
    try {
      const docJson = await invoke<string>("get_public_did_document", {
        did: activeDid,
      });
      const blob = new Blob([docJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "did.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(`Export failed: ${err.toString()}`);
    }
  };

  // --- Seed Reveal ---
  const openSeedModal = () => {
    setSeedConfirmText("");
    setSeedCountdown(10);
    setRevealedSeed(null);
    setShowSeedModal(true);

    // Start 10-second countdown
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setSeedCountdown((prev) => {
        if (prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleRevealSeed = async () => {
    try {
      const hex = await invoke<string>("reveal_master_seed");
      setRevealedSeed(hex);

      // Auto-dismiss after 30 seconds
      const timer = setTimeout(() => {
        setShowSeedModal(false);
        setRevealedSeed(null);
        setSeedAutoDismiss(null);
      }, 30_000);
      setSeedAutoDismiss(timer);
    } catch (err: any) {
      setError(err.toString());
      setShowSeedModal(false);
    }
  };

  const closeSeedModal = () => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (seedAutoDismiss) clearTimeout(seedAutoDismiss);
    setSeedAutoDismiss(null);
    setShowSeedModal(false);
    setRevealedSeed(null);
    setSeedConfirmText("");
  };

  // --- Backup Export ---
  const handleExportBackup = async () => {
    setBackupPassword("");
    setShowBackupPassword(true);
  };

  const executeExport = async () => {
    if (!backupPassword) return;
    setBackupLoading(true);
    setError(null);
    try {
      const bytes = await invoke<number[]>("create_vault_backup", {
        password: backupPassword,
      });

      // Trigger file save dialog
      const filePath = await save({
        defaultPath: "iyou_home_backup.iyoubackup",
        filters: [{ name: "iYou Backup", extensions: ["iyoubackup"] }],
      });

      if (filePath) {
        await invoke("write_binary_file", {
          path: filePath,
          contents: bytes,
        });
      }

      setShowBackupPassword(false);
      setBackupPassword("");
    } catch (err: any) {
      setError(`Backup export failed: ${err.toString()}`);
    } finally {
      setBackupLoading(false);
    }
  };

  // --- Backup Restore ---
  const handleRestoreBackup = async () => {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "iYou Backup", extensions: ["iyoubackup"] }],
      });

      if (!selected) return;

      // Read file contents via native binary IPC
      const bytes = await invoke<number[]>("read_binary_file", {
        path: selected,
      });

      setPendingRestoreBytes(bytes);
      setRestorePassword("");
      setShowRestorePassword(true);
    } catch (err: any) {
      setError(`Failed to read backup file: ${err.toString()}`);
    }
  };

  const executeRestore = async () => {
    if (!restorePassword || !pendingRestoreBytes) return;
    setRestoreLoading(true);
    setError(null);
    try {
      await invoke("restore_vault_backup", {
        backupBytes: pendingRestoreBytes,
        password: restorePassword,
      });
      setShowRestorePassword(false);
      setRestorePassword("");
      setPendingRestoreBytes(null);
      await fetchData();
    } catch (err: any) {
      setError(`Restore failed: ${err.toString()}`);
    } finally {
      setRestoreLoading(false);
    }
  };

  // --- Vault Wipe & Reset ---
  const handleWipeAndReset = async () => {
    if (
      !window.confirm(
        "⚠️ Are you absolutely sure you want to wipe and reset your enclave vault? This will permanently erase your local personas, contacts, and credentials unless you have an offline backup.",
      )
    ) {
      return;
    }
    setIsGenerating(true);
    setError(null);
    try {
      await invoke("generate_did");
      await fetchData();
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsGenerating(false);
    }
  };

  // --- Advanced Import ---
  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await invoke("import_did", { did: importDid, privateKey: importKey });
      await fetchData();
      setImportDid("");
      setImportKey("");
    } catch (err: any) {
      setError(err.toString());
    }
  };

  // --- Global Session Revocation ---
  const handleConfirmRevoke = async () => {
    setRevokeLoading(true);
    setError(null);
    setRevokeSuccessMsg(null);
    try {
      await invoke<string>("revoke_all_sessions");
      setRevokeSuccessMsg("✅ All active web sessions revoked successfully.");
      setShowRevokeModal(false);
    } catch (err: any) {
      setError(`Revocation failed: ${err.toString()}`);
      setShowRevokeModal(false);
    } finally {
      setRevokeLoading(false);
    }
  };

  // --- App Lock & Inactivity Handlers ---
  const handleToggleAppLock = async () => {
    setLockErrorMessage(null);
    setLockStatusMessage(null);
    const current = appPrefs || DEFAULT_USER_PREFERENCES;
    if (current.app_lock_enabled) {
      const updated: UserPreferences = {
        ...current,
        app_lock_enabled: false,
      };
      try {
        await saveUserPreferences(updated);
        setAppPrefs(updated);
        onLockSettingsChange?.(updated);
        setLockStatusMessage("App lock disabled.");
      } catch (err: any) {
        setLockErrorMessage(`Failed to disable app lock: ${err.toString()}`);
      }
    } else {
      if (current.app_lock_pin_hash) {
        const updated: UserPreferences = {
          ...current,
          app_lock_enabled: true,
        };
        try {
          await saveUserPreferences(updated);
          setAppPrefs(updated);
          onLockSettingsChange?.(updated);
          setLockStatusMessage("App lock enabled.");
        } catch (err: any) {
          setLockErrorMessage(`Failed to enable app lock: ${err.toString()}`);
        }
      } else {
        setShowPinModal(true);
      }
    }
  };

  const handleSavePin = async () => {
    setLockErrorMessage(null);
    if (!isValidAppLockPin(newPin)) {
      setLockErrorMessage("PIN must be exactly 6 digits.");
      return;
    }
    if (newPin !== confirmPin) {
      setLockErrorMessage("PINs do not match.");
      return;
    }
    try {
      const pinHash = await sha256Hex(newPin);
      const current = appPrefs || DEFAULT_USER_PREFERENCES;
      const updated: UserPreferences = {
        ...current,
        app_lock_enabled: true,
        app_lock_pin_hash: pinHash,
      };
      await saveUserPreferences(updated);
      setAppPrefs(updated);
      onLockSettingsChange?.(updated);
      setShowPinModal(false);
      setNewPin("");
      setConfirmPin("");
      setLockStatusMessage("PIN set and App Lock enabled.");
    } catch (err: any) {
      setLockErrorMessage(`Failed to save PIN: ${err.toString()}`);
    }
  };

  const handleChangeTimeout = async (minutes: number) => {
    const current = appPrefs || DEFAULT_USER_PREFERENCES;
    const updated: UserPreferences = {
      ...current,
      inactivity_timeout_minutes: minutes,
    };
    try {
      await saveUserPreferences(updated);
      setAppPrefs(updated);
      onLockSettingsChange?.(updated);
    } catch (err: any) {
      setLockErrorMessage(`Failed to update timeout: ${err.toString()}`);
    }
  };

  const handleEnrollBiometrics = async () => {
    setBiometricEnrolling(true);
    setLockErrorMessage(null);
    try {
      const result = await getOrRegisterPrfSeed(DEFAULT_PRF_SALT);
      const prfHash = await sha256Hex(result.prfSeedHex);
      const current = appPrefs || DEFAULT_USER_PREFERENCES;
      const updated: UserPreferences = {
        ...current,
        app_lock_prf_hash: prfHash,
      };
      await saveUserPreferences(updated);
      setAppPrefs(updated);
      onLockSettingsChange?.(updated);
      setLockStatusMessage("Biometrics / Passkey enrolled successfully.");
    } catch (err: any) {
      setLockErrorMessage(`Biometric enrollment failed: ${err?.message ?? String(err)}`);
    } finally {
      setBiometricEnrolling(false);
    }
  };

  const handleRemoveBiometrics = async () => {
    setLockErrorMessage(null);
    const current = appPrefs || DEFAULT_USER_PREFERENCES;
    const updated: UserPreferences = {
      ...current,
      app_lock_prf_hash: null,
    };
    try {
      await saveUserPreferences(updated);
      setAppPrefs(updated);
      onLockSettingsChange?.(updated);
      setLockStatusMessage("Biometrics removed.");
    } catch (err: any) {
      setLockErrorMessage(`Failed to remove biometrics: ${err.toString()}`);
    }
  };

  const seedConfirmValid = seedConfirmText === "REVEAL MY SEED";

  return (
    <div className="component-container">
      <h2>Identity Vault &amp; Disaster Recovery</h2>
      <div
        className="vault-badge"
        title="Keys are managed securely by the local Rust process"
      >
        Vault Mode Active
      </div>

      {error && <div className="error-message">{error}</div>}

      {revokeSuccessMsg && (
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#166534",
            padding: "0.75rem 1rem",
            borderRadius: "6px",
            marginBottom: "1rem",
            fontSize: "0.9rem",
            fontWeight: 500,
          }}
        >
          {revokeSuccessMsg}
        </div>
      )}

      {/* Active Identity */}
      <div className="section">
        <h3>Active Identity</h3>
        {activeDid ? (
          <div>
            {activeProfile && (
              <div
                style={{
                  fontSize: "0.85rem",
                  color: "var(--color-text-secondary)",
                  marginBottom: "0.5rem",
                  fontWeight: 500,
                }}
              >
                {activeProfile.profile_name} · {levelLabel(activeProfile.level)} (Index #{activeProfile.derivation_index})
              </div>
            )}
            <code className="did-display" style={{ marginBottom: "1rem" }}>
              {activeDid}
            </code>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                flexWrap: "wrap",
                marginTop: "0.75rem",
              }}
            >
              <button onClick={handleCopyDid}>
                {copied ? "\u2713 Copied" : "\uD83D\uDCCB Copy DID"}
              </button>
              <button onClick={handleExportDocument}>
                Export Public DID Document
              </button>
            </div>
          </div>
        ) : (
          <p className="muted">No active identity found.</p>
        )}
      </div>

      {/* Sovereign Data Redundancy Callout */}
      <div
        style={{
          background: "var(--color-bg-secondary, #f8fafc)",
          border: "1px solid var(--color-border, #e2e8f0)",
          borderRadius: "8px",
          padding: "1rem 1.25rem",
          marginBottom: "1.25rem",
        }}
      >
        <div
          style={{
            fontWeight: 600,
            fontSize: "0.95rem",
            color: "var(--color-text, #0f172a)",
            marginBottom: "0.35rem",
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          {"\uD83D\uDEE1\uFE0F"} Sovereign Data Redundancy
        </div>
        <p
          style={{
            fontSize: "0.83rem",
            color: "var(--color-text-secondary, #64748b)",
            margin: "0 0 0.5rem 0",
            lineHeight: "1.5",
          }}
        >
          Your identity and content are protected through three independent, zero-cost redundancy paths:
        </p>
        <ul
          style={{
            margin: 0,
            paddingLeft: "1.25rem",
            fontSize: "0.82rem",
            color: "var(--color-text-secondary, #475569)",
            lineHeight: "1.6",
          }}
        >
          <li>
            <strong>Local Archive Export:</strong> Create password-encrypted <code>.iyoubackup</code> snapshots stored safely on your local disk or flash drive.
          </li>
          <li>
            <strong>Self-Hosted Home NAS / Blossom Node:</strong> Mirror media blobs and credentials automatically to your personal Blossom store (<code>:9002</code>).
          </li>
          <li>
            <strong>Public Nostr Relays:</strong> Publish tamper-evident signed notes and timeline articles to decentralized Nostr relays (<code>:9003</code>).
          </li>
        </ul>
      </div>

      {/* Mobile Device Pairing */}
      <DevicePairing />

      {/* Encrypted Backup & Recovery */}
      <div className="section">
        <h3>Encrypted Backup &amp; Recovery</h3>
        <p className="muted" style={{ marginBottom: "0.75rem" }}>
          Export an encrypted <code>.iyoubackup</code> archive of your vault,
          contacts, and preferences. Protected with a password of your choice.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button onClick={handleExportBackup}>
            Export Encrypted Backup (.iyoubackup)
          </button>
          <button onClick={handleRestoreBackup}>
            Restore from .iyoubackup
          </button>
        </div>
      </div>

      {/* Session Kill-Switch Card */}
      <div
        className="section"
        style={{
          border: "1px solid #fed7aa",
          background: "#fffbeb",
          borderRadius: "8px",
        }}
      >
        <h3 style={{ color: "#9a3412" }}>{"\uD83D\uDED1"} Active Web Sessions</h3>
        <p
          className="muted"
          style={{ color: "#7c2d12", marginBottom: "0.75rem" }}
        >
          Kill all active logins across satellite web apps (iyou_wun, iyou_poly, etc.) instantly. Use this if you logged in on a public or shared computer.
        </p>
        <button
          onClick={() => {
            setError(null);
            setRevokeSuccessMsg(null);
            setShowRevokeModal(true);
          }}
          style={{
            background: "transparent",
            border: "1px solid #ea580c",
            color: "#c2410c",
            fontWeight: 600,
          }}
        >
          {"\uD83D\uDED1"} Revoke All Web Sessions
        </button>
      </div>

      {/* App Lock & Inactivity Guard */}
      <div className="section">
        <h3>{"\uD83D\uDD12"} App Lock &amp; Inactivity Guard</h3>
        <p className="muted" style={{ marginBottom: "0.75rem" }}>
          Require authentication to access iyou_home and automatically lock when inactive.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontWeight: 600 }}>
            <input
              type="checkbox"
              checked={appPrefs?.app_lock_enabled ?? false}
              onChange={handleToggleAppLock}
            />
            Enable App Lock
          </label>

          {appPrefs?.app_lock_enabled && (
            <button
              onClick={() => {
                setLockErrorMessage(null);
                setShowPinModal(true);
              }}
              style={{
                fontSize: "0.85rem",
                padding: "0.35rem 0.75rem",
                background: "transparent",
                border: "1px solid #d1d5db",
              }}
            >
              {appPrefs?.app_lock_pin_hash ? "Change PIN" : "Set 6-Digit PIN"}
            </button>
          )}
        </div>

        {appPrefs?.app_lock_enabled && (
          <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <label style={{ fontSize: "0.88rem", fontWeight: 500 }}>Auto-lock timeout:</label>
              <select
                value={appPrefs.inactivity_timeout_minutes}
                onChange={(e) => handleChangeTimeout(Number(e.target.value))}
                style={{
                  padding: "0.35rem 0.6rem",
                  borderRadius: "6px",
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  fontSize: "0.88rem",
                }}
              >
                {INACTIVITY_TIMEOUT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {webauthnPrfSupported() && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.25rem" }}>
                {appPrefs.app_lock_prf_hash ? (
                  <>
                    <span style={{ fontSize: "0.85rem", color: "#16a34a" }}>
                      {"\u2713"} Biometrics / Passkey enrolled
                    </span>
                    <button
                      onClick={handleRemoveBiometrics}
                      style={{
                        fontSize: "0.8rem",
                        padding: "0.25rem 0.5rem",
                        background: "transparent",
                        border: "1px solid #ef4444",
                        color: "#dc2626",
                      }}
                    >
                      Remove Biometrics
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleEnrollBiometrics}
                    disabled={biometricEnrolling}
                    style={{
                      fontSize: "0.85rem",
                      padding: "0.35rem 0.75rem",
                      background: "transparent",
                      border: "1px solid #d1d5db",
                    }}
                  >
                    {biometricEnrolling ? "Enrolling…" : "\uD83D\uDC64 Enroll Biometrics / Passkey"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {lockStatusMessage && (
          <p style={{ fontSize: "0.85rem", color: "#16a34a", marginTop: "0.5rem" }}>
            {lockStatusMessage}
          </p>
        )}
        {lockErrorMessage && (
          <p style={{ fontSize: "0.85rem", color: "#dc2626", marginTop: "0.5rem" }}>
            {lockErrorMessage}
          </p>
        )}
      </div>

      {/* Software Updates & Verification */}
      <div className="section" style={{ marginTop: "1rem" }}>
        <h3>Software Updates & Verification</h3>
        <p className="muted" style={{ marginBottom: "0.85rem" }}>
          Control remote update polling and cryptographically inspect release binaries before execution.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginBottom: "1rem" }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="update_policy"
              value="locked"
              checked={updatePrefs.policy === "locked"}
              onChange={() => handleUpdatePolicyChange("locked")}
              style={{ marginTop: "0.2rem" }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "#1e293b" }}>
                🔒 Air-Gapped / Locked
              </div>
              <div style={{ fontSize: "0.78rem", color: "#64748b" }}>
                Zero network polling. Disables all remote version checks and auto-update triggers.
              </div>
            </div>
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="update_policy"
              value="manual"
              checked={updatePrefs.policy === "manual"}
              onChange={() => handleUpdatePolicyChange("manual")}
              style={{ marginTop: "0.2rem" }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "#1e293b" }}>
                👁️ Manual Review (Recommended)
              </div>
              <div style={{ fontSize: "0.78rem", color: "#64748b" }}>
                Poll on demand or surface subtle notifications; require manual cryptographic signature inspection before applying.
              </div>
            </div>
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="update_policy"
              value="auto"
              checked={updatePrefs.policy === "auto"}
              onChange={() => handleUpdatePolicyChange("auto")}
              style={{ marginTop: "0.2rem" }}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.88rem", color: "#1e293b" }}>
                ⚡ Automatic
              </div>
              <div style={{ fontSize: "0.78rem", color: "#64748b" }}>
                Download verified updates in background and prompt to restart.
              </div>
            </div>
          </label>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "0.82rem", color: "#475569", fontWeight: 600 }}>Release Channel:</span>
            <select
              value={updatePrefs.release_channel}
              onChange={(e) => handleReleaseChannelChange(e.target.value)}
              style={{
                fontSize: "0.82rem",
                padding: "0.25rem 0.6rem",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
              }}
            >
              <option value="stable">Stable (Verified)</option>
              <option value="beta">Beta (Preview)</option>
            </select>
          </div>

          <button
            type="button"
            onClick={handleCheckUpdates}
            disabled={updateChecking}
            style={{
              fontSize: "0.82rem",
              padding: "0.4rem 0.9rem",
              background: "#2563eb",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              cursor: updateChecking ? "not-allowed" : "pointer",
            }}
          >
            {updateChecking ? "Checking Manifest…" : "🔄 Check for Updates Now"}
          </button>
        </div>

        {updateStatusMessage && (
          <div
            style={{
              marginTop: "0.75rem",
              fontSize: "0.82rem",
              fontWeight: 600,
              color: updateStatusMessage.startsWith("✓") ? "#16a34a" : "#dc2626",
            }}
          >
            {updateStatusMessage}
          </div>
        )}
      </div>

      {/* Master Seed Reveal */}
      <div className="section">
        <h3>Master Seed</h3>
        <p className="muted" style={{ marginBottom: "0.75rem" }}>
          Your 64-character hex master seed is the root of all derived
          identities. Keep it offline and never share it.
        </p>
        <button
          onClick={openSeedModal}
          style={{
            background: "transparent",
            border: "1px solid #d97706",
            color: "#92400e",
          }}
        >
          Reveal Master Seed
        </button>
      </div>

      {/* Advanced / Legacy Import */}
      <details style={{ marginTop: "1rem" }}>
        <summary
          style={{
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "0.9rem",
            color: "var(--color-text-muted)",
            padding: "0.5rem 0",
          }}
        >
          Advanced / Legacy Import
        </summary>
        <div className="section" style={{ marginTop: "0.5rem" }}>
          <h3>Import Seed / Identity Recovery</h3>
          <form onSubmit={handleImport}>
            <div className="form-group">
              <label>DID</label>
              <input
                type="text"
                value={importDid}
                onChange={(e) => setImportDid(e.target.value)}
                placeholder="did:key:..."
                required
              />
            </div>
            <div className="form-group">
              <label>Private Key (Base58)</label>
              <input
                type="password"
                value={importKey}
                onChange={(e) => setImportKey(e.target.value)}
                placeholder="Base58 encoded seed"
                required
              />
            </div>
            <button type="submit">Import Key</button>
          </form>
        </div>
      </details>

      {/* Danger Zone: Wipe & Reset + Binary Rollback */}
      <details
        className="mt-8 border border-red-900/40 rounded-lg p-4 bg-red-950/10"
        style={{
          marginTop: "1.5rem",
          border: "1px solid rgba(220, 38, 38, 0.3)",
          borderRadius: "8px",
          padding: "1rem",
          background: "rgba(220, 38, 38, 0.05)",
        }}
      >
        <summary
          className="text-xs font-semibold text-red-400 cursor-pointer select-none"
          style={{
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "0.85rem",
            color: "#dc2626",
          }}
        >
          ⚠️ Danger Zone: Wipe &amp; Reset &amp; Binary Rollback
        </summary>
        <div
          className="mt-3 text-xs text-slate-400 space-y-2"
          style={{
            marginTop: "0.75rem",
            fontSize: "0.82rem",
            color: "var(--color-text-secondary, #64748b)",
          }}
        >
          <p style={{ margin: "0 0 0.75rem 0", lineHeight: "1.5" }}>
            Wiping your vault permanently destroys all local persona keys, contacts, and credentials unless you have an offline seed phrase or .iyoubackup archive.
          </p>
          <button
            onClick={handleWipeAndReset}
            disabled={isGenerating}
            className="px-3 py-1.5 bg-red-900/30 hover:bg-red-800/50 border border-red-700/60 rounded text-red-300 font-mono text-xs transition"
            style={{
              background: "#fee2e2",
              border: "1px solid #f87171",
              color: "#991b1b",
              fontWeight: 600,
              fontSize: "0.8rem",
            }}
          >
            {isGenerating ? "Wiping & Regenerating..." : "Wipe & Regenerate Vault"}
          </button>

          {/* Binary Rollback Section */}
          <div style={{ marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(220, 38, 38, 0.2)" }}>
            <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "#991b1b", marginBottom: "0.3rem" }}>
              One-Click Binary Rollback
            </div>
            <p style={{ margin: "0 0 0.6rem 0", lineHeight: "1.4", fontSize: "0.8rem" }}>
              {hasRollback
                ? "A staged snapshot of your prior binary exists (bin/iyou-home.previous). If a newly installed version exhibits faults, you can immediately revert to the previous executable."
                : "No previous binary snapshot found on disk. Rollback snapshots are automatically staged during updates."}
            </p>
            <button
              type="button"
              onClick={() => setShowRollbackConfirm(true)}
              disabled={!hasRollback || rollbackLoading}
              style={{
                background: hasRollback ? "#fee2e2" : "#f1f5f9",
                border: hasRollback ? "1px solid #f87171" : "1px solid #cbd5e1",
                color: hasRollback ? "#991b1b" : "#94a3b8",
                fontWeight: 600,
                fontSize: "0.8rem",
                cursor: hasRollback ? "pointer" : "not-allowed",
              }}
            >
              {rollbackLoading ? "Restoring Previous Binary…" : "⏪ Rollback to Previous Version"}
            </button>
            {rollbackStatusMessage && (
              <p style={{ marginTop: "0.5rem", fontSize: "0.82rem", color: "#16a34a", fontWeight: 600 }}>
                {rollbackStatusMessage}
              </p>
            )}
          </div>
        </div>
      </details>

      {/* ========== Seed Reveal Modal ========== */}
      {showSeedModal && (
        <div className="modal-overlay" onClick={closeSeedModal}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "520px" }}
          >
            <h3>Master Seed Reveal</h3>

            <div
              style={{
                background: "#fef3c7",
                border: "1px solid #fbbf24",
                borderRadius: "8px",
                padding: "0.75rem 1rem",
                marginBottom: "1rem",
                fontSize: "0.9rem",
                color: "#92400e",
              }}
            >
              <strong>Warning:</strong> Never share your master seed. Anyone
              with this phrase has lifetime control over all personas.
            </div>

            {revealedSeed ? (
              <div>
                <pre
                  style={{
                    background: "#1e1b4b",
                    color: "#c7d2fe",
                    padding: "1rem",
                    borderRadius: "8px",
                    fontSize: "0.82rem",
                    fontFamily: "monospace",
                    wordBreak: "break-all",
                    lineHeight: "1.6",
                    marginBottom: "0.75rem",
                  }}
                >
                  {revealedSeed}
                </pre>
                <p
                  style={{
                    fontSize: "0.78rem",
                    color: "var(--color-text-muted)",
                    margin: 0,
                  }}
                >
                  This seed will automatically hide in 30 seconds.
                </p>
              </div>
            ) : (
              <div>
                <div className="form-group">
                  <label>
                    Type <code>REVEAL MY SEED</code> to confirm:
                  </label>
                  <input
                    type="text"
                    value={seedConfirmText}
                    onChange={(e) => setSeedConfirmText(e.target.value)}
                    placeholder="REVEAL MY SEED"
                  />
                </div>
                <button
                  onClick={handleRevealSeed}
                  disabled={!seedConfirmValid || seedCountdown > 0}
                  style={{
                    opacity: seedConfirmValid && seedCountdown === 0 ? 1 : 0.5,
                    cursor:
                      seedConfirmValid && seedCountdown === 0
                        ? "pointer"
                        : "not-allowed",
                  }}
                >
                  {seedCountdown > 0
                    ? `Wait ${seedCountdown}s...`
                    : "Show Seed"}
                </button>
              </div>
            )}

            <div style={{ marginTop: "1rem", textAlign: "right" }}>
              <button
                onClick={closeSeedModal}
                style={{
                  background: "#f3f4f6",
                  border: "1px solid #d1d5db",
                  color: "var(--color-text-secondary)",
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Backup Password Modal ========== */}
      {showBackupPassword && (
        <div
          className="modal-overlay"
          onClick={() => setShowBackupPassword(false)}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "440px" }}
          >
            <h3>Set Backup Password</h3>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Choose a strong password. This password is required to restore
              the backup.
            </p>
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={backupPassword}
                onChange={(e) => setBackupPassword(e.target.value)}
                placeholder="Enter backup password"
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
              <button
                onClick={executeExport}
                disabled={!backupPassword || backupLoading}
                style={{ background: "#137333", color: "white" }}
              >
                {backupLoading ? "Encrypting..." : "Export Backup"}
              </button>
              <button
                onClick={() => setShowBackupPassword(false)}
                style={{
                  background: "#f3f4f6",
                  border: "1px solid #d1d5db",
                  color: "var(--color-text-secondary)",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Restore Password Modal ========== */}
      {showRestorePassword && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowRestorePassword(false);
            setPendingRestoreBytes(null);
          }}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "440px" }}
          >
            <h3>Restore Backup</h3>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Enter the password used when this backup was created. This will
              overwrite your current vault, contacts, and preferences.
            </p>
            <div className="form-group">
              <label>Backup Password</label>
              <input
                type="password"
                value={restorePassword}
                onChange={(e) => setRestorePassword(e.target.value)}
                placeholder="Enter backup password"
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
              <button
                onClick={executeRestore}
                disabled={!restorePassword || restoreLoading}
                style={{ background: "#dc2626", color: "white" }}
              >
                {restoreLoading ? "Restoring..." : "Restore & Overwrite"}
              </button>
              <button
                onClick={() => {
                  setShowRestorePassword(false);
                  setPendingRestoreBytes(null);
                }}
                style={{
                  background: "#f3f4f6",
                  border: "1px solid #d1d5db",
                  color: "var(--color-text-secondary)",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Revoke All Sessions Confirmation Modal ========== */}
      {showRevokeModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!revokeLoading) setShowRevokeModal(false);
          }}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "480px" }}
          >
            <h3 style={{ color: "#dc2626" }}>{"\uD83D\uDED1"} Confirm Global Session Revocation</h3>
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "8px",
                padding: "0.75rem 1rem",
                marginBottom: "1rem",
                fontSize: "0.88rem",
                color: "#991b1b",
                lineHeight: "1.5",
              }}
            >
              This will immediately log you out of all web browsers and satellite apps. You will need to re-authenticate with iyou_home to sign back in.
            </div>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                marginTop: "1rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                onClick={() => setShowRevokeModal(false)}
                disabled={revokeLoading}
                style={{
                  background: "#f3f4f6",
                  border: "1px solid #d1d5db",
                  color: "var(--color-text-secondary)",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRevoke}
                disabled={revokeLoading}
                style={{
                  background: "#dc2626",
                  border: "1px solid #b91c1c",
                  color: "white",
                  fontWeight: 600,
                }}
              >
                {revokeLoading ? "Revoking..." : "Confirm Revocation"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Set / Change App Lock PIN Modal ========== */}
      {showPinModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowPinModal(false);
            setNewPin("");
            setConfirmPin("");
            setLockErrorMessage(null);
          }}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "400px" }}
          >
            <h3>{appPrefs?.app_lock_pin_hash ? "Change App Lock PIN" : "Set 6-Digit App Lock PIN"}</h3>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>
              Enter a 6-digit numeric PIN to protect access to iyou_home.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSavePin();
              }}
            >
              <div className="form-group">
                <label>New 6-Digit PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="6 digits"
                  autoFocus
                  required
                />
              </div>
              <div className="form-group">
                <label>Confirm PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
                  placeholder="Re-enter 6 digits"
                  required
                />
              </div>
              {lockErrorMessage && (
                <div
                  style={{
                    marginBottom: "1rem",
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    color: "#b91c1c",
                    padding: "0.5rem 0.75rem",
                    borderRadius: "6px",
                    fontSize: "0.85rem",
                  }}
                >
                  {lockErrorMessage}
                </div>
              )}
              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end", marginTop: "1rem" }}>
                <button
                  type="button"
                  onClick={() => {
                    setShowPinModal(false);
                    setNewPin("");
                    setConfirmPin("");
                    setLockErrorMessage(null);
                  }}
                  style={{
                    background: "#f3f4f6",
                    border: "1px solid #d1d5db",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={newPin.length !== 6 || confirmPin.length !== 6}
                  style={{
                    background: "#137333",
                    color: "white",
                    opacity: newPin.length !== 6 || confirmPin.length !== 6 ? 0.5 : 1,
                  }}
                >
                  Save PIN
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========== Rollback Confirmation Modal ========== */}
      {showRollbackConfirm && (
        <div className="modal-overlay" onClick={() => setShowRollbackConfirm(false)}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "460px" }}
          >
            <h3 style={{ color: "#dc2626" }}>Confirm Binary Rollback</h3>
            <p className="muted" style={{ fontSize: "0.85rem", lineHeight: "1.5", marginBottom: "1rem" }}>
              Are you sure you want to replace the current executable with the previous binary snapshot? This will restore the prior version. You should restart the application after rollback.
            </p>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setShowRollbackConfirm(false)}
                disabled={rollbackLoading}
                style={{
                  background: "#f3f4f6",
                  border: "1px solid #d1d5db",
                  color: "var(--color-text-secondary)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteRollback}
                disabled={rollbackLoading}
                style={{
                  background: "#dc2626",
                  border: "1px solid #b91c1c",
                  color: "#ffffff",
                  fontWeight: 600,
                }}
              >
                {rollbackLoading ? "Restoring…" : "Confirm Rollback"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Update Vetting Modal ========== */}
      <UpdateVettingModal
        isOpen={showVettingModal}
        onClose={() => setShowVettingModal(false)}
        updateMetadata={vettedUpdate}
        onInstallComplete={() => {
          setHasRollback(true);
          setShowVettingModal(false);
        }}
        onSkipVersion={async (version) => {
          const next = { ...updatePrefs, ignored_version: version };
          setUpdatePrefs(next);
          try {
            await invoke("set_update_preferences", { prefs: next });
          } catch (e) {
            console.error("Failed to save ignored version:", e);
          }
        }}
      />
    </div>
  );
}
