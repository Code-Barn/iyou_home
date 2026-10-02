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

import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Profile, UpdateMetadata, UpdatePolicy, UpdatePreferences, UserPreferences } from "../lib/types";
import { DEFAULT_USER_PREFERENCES } from "../lib/types";
import {
  INACTIVITY_TIMEOUT_OPTIONS,
  SIGNING_GRACE_PERIOD_OPTIONS,
  isValidAppLockPin,
  loadUserPreferences,
  saveUserPreferences,
  sha256Hex,
} from "../lib/appLock";
import DevicePairing from "./DevicePairing";
import UpdateVettingModal from "./updater/UpdateVettingModal";
import FamilyEnclave from "./family/FamilyEnclave";
import DependentsManager from "./DependentsManager";

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

  // Hardened Master Seed Reveal
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [seedPin, setSeedPin] = useState("");
  const [seedPinError, setSeedPinError] = useState<string | null>(null);
  const [seedConfirmText, setSeedConfirmText] = useState("");
  const [revealedSeed, setRevealedSeed] = useState<string | null>(null);
  const [seedCopied, setSeedCopied] = useState(false);
  const [seedRemainingSeconds, setSeedRemainingSeconds] = useState(30);
  const [seedAutoDismiss, setSeedAutoDismiss] = useState<ReturnType<typeof setTimeout> | null>(null);
  const seedTimerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Backup Password Modal
  const [showBackupPassword, setShowBackupPassword] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupLoading, setBackupLoading] = useState(false);

  // Restore flow
  const [showRestorePassword, setShowRestorePassword] = useState(false);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [pendingRestoreBytes, setPendingRestoreBytes] = useState<number[] | null>(null);

  // Advanced / Legacy import
  const [importDid, setImportDid] = useState("");
  const [importKey, setImportKey] = useState("");

  // Global Session Revocation
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [revokeSuccessMsg, setRevokeSuccessMsg] = useState<string | null>(null);

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

  useEffect(() => {
    if (propPrefs !== undefined) {
      setAppPrefs(propPrefs);
    } else {
      loadUserPreferences().then(setAppPrefs);
    }
  }, [propPrefs]);

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

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (seedTimerIntervalRef.current) clearInterval(seedTimerIntervalRef.current);
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

  // --- Seed Reveal (Hardened) ---
  const openSeedModal = () => {
    setSeedPin("");
    setSeedPinError(null);
    setSeedConfirmText("");
    setRevealedSeed(null);
    setSeedCopied(false);
    setSeedRemainingSeconds(30);
    setShowSeedModal(true);
  };

  const closeSeedModal = () => {
    if (seedTimerIntervalRef.current) clearInterval(seedTimerIntervalRef.current);
    if (seedAutoDismiss) clearTimeout(seedAutoDismiss);
    setSeedAutoDismiss(null);
    setShowSeedModal(false);
    setRevealedSeed(null);
    setSeedPin("");
    setSeedPinError(null);
    setSeedConfirmText("");
    setSeedCopied(false);
  };

  const executeRevealSeed = async () => {
    try {
      const hex = await invoke<string>("reveal_master_seed");
      setRevealedSeed(hex);
      setSeedRemainingSeconds(30);

      if (seedTimerIntervalRef.current) clearInterval(seedTimerIntervalRef.current);
      seedTimerIntervalRef.current = setInterval(() => {
        setSeedRemainingSeconds((prev) => {
          if (prev <= 1) {
            if (seedTimerIntervalRef.current) clearInterval(seedTimerIntervalRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      if (seedAutoDismiss) clearTimeout(seedAutoDismiss);
      const timer = setTimeout(() => {
        closeSeedModal();
      }, 30_000);
      setSeedAutoDismiss(timer);
    } catch (err: any) {
      setError(err.toString());
      closeSeedModal();
    }
  };

  const handleVerifyPinAndReveal = async () => {
    if (!seedPin || seedPin.length !== 6) return;
    try {
      const pinHash = await sha256Hex(seedPin);
      if (pinHash !== appPrefs?.app_lock_pin_hash) {
        setSeedPinError("Incorrect PIN.");
        return;
      }
      setSeedPin("");
      setSeedPinError(null);
      await executeRevealSeed();
    } catch (err: any) {
      setSeedPinError(`Verification failed: ${err.toString()}`);
    }
  };

  const handleVerifyBiometricsAndReveal = async () => {
    try {
      const ok = await invoke<boolean>("verify_biometric_auth", {
        reason: "Verify biometrics to reveal master seed",
      });
      if (ok) {
        await executeRevealSeed();
      }
    } catch {
      setSeedPinError("Biometric verification failed.");
    }
  };

  const handleCopyMasterSeed = async () => {
    if (!revealedSeed) return;
    try {
      await writeText(revealedSeed);
    } catch {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(revealedSeed);
      }
    }
    setSeedCopied(true);
    setTimeout(() => setSeedCopied(false), 2500);
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

      const filePath = await save({
        defaultPath: "iyou_home_backup.iyoubackup",
        filters: [{ name: "iyou Backup", extensions: ["iyoubackup"] }],
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
        filters: [{ name: "iyou Backup", extensions: ["iyoubackup"] }],
      });

      if (!selected) return;

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

  const handleChangeGracePeriod = async (minutes: number) => {
    const current = appPrefs || DEFAULT_USER_PREFERENCES;
    const updated: UserPreferences = {
      ...current,
      signing_grace_period_minutes: minutes,
    };
    try {
      await saveUserPreferences(updated);
      try {
        localStorage.setItem("iyou_home_signing_grace_period", String(minutes));
      } catch {}
      setAppPrefs(updated);
      onLockSettingsChange?.(updated);
    } catch (err: any) {
      setLockErrorMessage(`Failed to update grace period: ${err.toString()}`);
    }
  };

  const handleEnrollBiometrics = async () => {
    setBiometricEnrolling(true);
    setLockErrorMessage(null);
    setLockStatusMessage(null);
    try {
      const success = await invoke<boolean>("verify_biometric_auth", {
        reason: "Enroll Touch ID / Passkey for iyou_home App Lock",
      });
      if (success) {
        const current = appPrefs || DEFAULT_USER_PREFERENCES;
        const updated: UserPreferences = {
          ...current,
          app_lock_prf_hash: "native_biometrics_enrolled",
        };
        await saveUserPreferences(updated);
        setAppPrefs(updated);
        onLockSettingsChange?.(updated);
        setLockStatusMessage("Biometrics enrolled successfully.");
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes("LAErrorBiometryNotEnrolled")) {
        setLockErrorMessage("Biometric enrollment failed: Touch ID is not enrolled on this Mac. Please configure Touch ID in System Settings.");
      } else {
        setLockErrorMessage(`Biometric enrollment failed: ${errMsg}`);
      }
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

  // --- Updater handlers ---
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

  const isPinProtected = Boolean(appPrefs?.app_lock_enabled && appPrefs?.app_lock_pin_hash);
  const seedConfirmValid = seedConfirmText === "REVEAL MY SEED";

  return (
    <div className="component-container" data-testid="settings-security-console">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <div>
          <h2 style={{ margin: 0 }}>Identity Vault &amp; Security Console</h2>
          <p className="muted" style={{ margin: "0.25rem 0 0 0", fontSize: "0.85rem" }}>
            Cryptographic identity roots, family delegation, device pairing, and backup redundancy.
          </p>
        </div>
        <div
          className="vault-badge"
          title="Keys are managed securely by the local Rust process"
        >
          Vault Mode Active
        </div>
      </div>

      {error && <div className="error-message" style={{ marginBottom: "1rem" }}>{error}</div>}

      {revokeSuccessMsg && (
        <div
          data-testid="revoke-success-msg"
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

      {/* Active Identity Root Header Card */}
      <div className="section" data-testid="active-identity-card" style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Active Primary Persona</h3>
          {activeProfile && (
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: "4px",
                background: "var(--color-bg-tertiary, #e2e8f0)",
                color: "var(--color-text-secondary, #475569)",
              }}
            >
              {levelLabel(activeProfile.level)} · Index #{activeProfile.derivation_index}
            </span>
          )}
        </div>

        {activeDid ? (
          <div style={{ marginTop: "0.75rem" }}>
            {activeProfile && (
              <div
                style={{
                  fontSize: "0.92rem",
                  color: "var(--color-text-primary, #0f172a)",
                  marginBottom: "0.4rem",
                  fontWeight: 600,
                }}
              >
                {activeProfile.profile_name}
              </div>
            )}
            <code className="did-display" style={{ marginBottom: "0.85rem", display: "block" }}>
              {activeDid}
            </code>
            <div
              style={{
                display: "flex",
                gap: "0.6rem",
                flexWrap: "wrap",
                marginTop: "0.5rem",
              }}
            >
              <button
                type="button"
                onClick={handleCopyDid}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.82rem", padding: "0.4rem 0.85rem" }}
              >
                {copied ? "\u2713 Copied" : "\uD83D\uDCCB Copy DID"}
              </button>
              <button
                type="button"
                onClick={handleExportDocument}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.82rem", padding: "0.4rem 0.85rem" }}
              >
                Export Public DID Document
              </button>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ marginTop: "0.5rem" }}>No active identity found.</p>
        )}
      </div>

      {/* ============================================================ */}
      {/* PILLAR 1: FAMILY & COMPANION DEVICES                         */}
      {/* ============================================================ */}
      <div className="settings-pillar pillar-family" data-testid="pillar-family-devices">
        <div className="settings-pillar-header">
          <span style={{ fontSize: "1.25rem" }}>{"\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66"}</span>
          <h3 className="settings-pillar-title">Pillar 1: Family &amp; Companion Devices</h3>
          <span className="settings-pillar-badge">Pillar 1</span>
        </div>
        <p className="muted" style={{ fontSize: "0.83rem", margin: "0 0 1.25rem 0" }}>
          Supervised child profiles, device provisioning, and companion mobile pairing derived from your family sovereign root.
        </p>

        {/* Companion Mobile Pairing */}
        <div style={{ marginBottom: "1.25rem" }}>
          <DevicePairing />
        </div>

        {/* Family Dependents */}
        <div>
          <DependentsManager />
        </div>

        {/* Collapsible RFC-005 Edge Child Pods */}
        <details style={{ marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid var(--color-surface-border, #e5e7eb)" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85rem", fontWeight: 600, color: "var(--color-text-secondary, #64748b)", userSelect: "none" }}>
            {"\uD83D\uDD17"} Edge Child Pods &amp; Shamir Escrow (RFC-005)
          </summary>
          <div style={{ marginTop: "0.75rem" }}>
            <FamilyEnclave />
          </div>
        </details>
      </div>

      {/* ============================================================ */}
      {/* PILLAR 2: ENCLAVE SECURITY & ACCESS                          */}
      {/* ============================================================ */}
      <div className="settings-pillar pillar-security" data-testid="pillar-enclave-security">
        <div className="settings-pillar-header">
          <span style={{ fontSize: "1.25rem" }}>{"\uD83D\uDD10"}</span>
          <h3 className="settings-pillar-title">Pillar 2: Enclave Security &amp; Access</h3>
          <span className="settings-pillar-badge">Pillar 2</span>
        </div>
        <p className="muted" style={{ fontSize: "0.83rem", margin: "0 0 1.25rem 0" }}>
          Hardened authentication guards, biometrics, master seed isolation, and global session revocation.
        </p>

        {/* App Lock & Inactivity Guard */}
        <div className="section" style={{ background: "var(--color-bg-secondary, #ffffff)", border: "1px solid var(--color-border, #e2e8f0)", borderRadius: "8px", padding: "1.15rem", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.4rem 0" }}>{"\uD83D\uDD12"} App Lock &amp; Inactivity Guard</h3>
          <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 0.85rem 0" }}>
            Require authentication to access iyou_home and automatically lock when inactive.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontWeight: 600, fontSize: "0.88rem" }}>
              <input
                type="checkbox"
                checked={appPrefs?.app_lock_enabled ?? false}
                onChange={handleToggleAppLock}
              />
              Enable App Lock
            </label>

            {appPrefs?.app_lock_enabled && (
              <button
                type="button"
                onClick={() => {
                  setLockErrorMessage(null);
                  setShowPinModal(true);
                }}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.82rem", padding: "0.35rem 0.75rem" }}
              >
                {appPrefs?.app_lock_pin_hash ? "Change PIN" : "Set 6-Digit PIN"}
              </button>
            )}
          </div>

          {appPrefs?.app_lock_enabled && (
            <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <label style={{ fontSize: "0.85rem", fontWeight: 500 }}>Auto-lock timeout:</label>
                <select
                  value={appPrefs.inactivity_timeout_minutes}
                  onChange={(e) => handleChangeTimeout(Number(e.target.value))}
                  style={{
                    padding: "0.35rem 0.6rem",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    fontSize: "0.85rem",
                  }}
                >
                  {INACTIVITY_TIMEOUT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <label style={{ fontSize: "0.85rem", fontWeight: 500 }}>Signing session grace period:</label>
                <select
                  aria-label="Signing session grace period"
                  value={appPrefs.signing_grace_period_minutes ?? 0}
                  onChange={(e) => handleChangeGracePeriod(Number(e.target.value))}
                  style={{
                    padding: "0.35rem 0.6rem",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                    background: "#fff",
                    fontSize: "0.85rem",
                  }}
                >
                  {SIGNING_GRACE_PERIOD_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
                {appPrefs.app_lock_prf_hash ? (
                  <>
                    <span style={{ fontSize: "0.82rem", color: "#16a34a", fontWeight: 600 }}>
                      {"\u2713"} Biometrics / Passkey enrolled
                    </span>
                    <button
                      type="button"
                      onClick={handleRemoveBiometrics}
                      className="btn-destructive bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium rounded-lg transition-colors"
                      style={{ fontSize: "0.8rem", padding: "0.25rem 0.55rem" }}
                    >
                      Remove Biometrics
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleEnrollBiometrics}
                    disabled={biometricEnrolling}
                    className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                    style={{ fontSize: "0.82rem", padding: "0.35rem 0.75rem" }}
                  >
                    {biometricEnrolling ? "Enrolling…" : "\uD83D\uDC64 Enroll Biometrics / Passkey"}
                  </button>
                )}
              </div>
            </div>
          )}

          {lockStatusMessage && (
            <p style={{ fontSize: "0.82rem", color: "#16a34a", marginTop: "0.5rem", marginBottom: 0 }}>
              {lockStatusMessage}
            </p>
          )}
          {lockErrorMessage && (
            <p style={{ fontSize: "0.82rem", color: "#dc2626", marginTop: "0.5rem", marginBottom: 0 }}>
              {lockErrorMessage}
            </p>
          )}
        </div>

        {/* Master Seed Reveal (Hardened) */}
        <div className="section" style={{ background: "var(--color-bg-secondary, #ffffff)", border: "1px solid var(--color-border, #e2e8f0)", borderRadius: "8px", padding: "1.15rem", marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
            <div>
              <h3 style={{ margin: "0 0 0.35rem 0" }}>{"\uD83D\uDD11"} Master Root Seed</h3>
              <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                Your 64-character hex master seed is the cryptographic root of all personas. Protected behind PIN challenge.
              </p>
            </div>
            <button
              type="button"
              data-testid="reveal-master-seed-btn"
              onClick={openSeedModal}
              className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
              style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
            >
              {"\uD83D\uDD11"} Reveal Master Seed
            </button>
          </div>
        </div>

        {/* Active Web Sessions Kill-Switch Card */}
        <div
          className="section"
          style={{
            border: "1px solid #fed7aa",
            background: "#fffbeb",
            borderRadius: "8px",
            padding: "1.15rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
            <div>
              <h3 style={{ color: "#9a3412", margin: "0 0 0.35rem 0" }}>{"\uD83D\uDED1"} Active Web Sessions</h3>
              <p style={{ color: "#7c2d12", margin: 0, fontSize: "0.82rem", lineHeight: "1.4" }}>
                Kill all active logins across satellite web apps (iyou_wun, iyou_poly) immediately.
              </p>
            </div>
            <button
              type="button"
              data-testid="kill-switch-btn"
              onClick={() => {
                setError(null);
                setRevokeSuccessMsg(null);
                setShowRevokeModal(true);
              }}
              className="btn-destructive bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium rounded-lg transition-colors"
              style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
            >
              {"\uD83D\uDED1"} Revoke All Web Sessions
            </button>
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* PILLAR 3: REDUNDANCY, STORAGE & UPDATES                      */}
      {/* ============================================================ */}
      <div className="settings-pillar pillar-redundancy" data-testid="pillar-redundancy-updates">
        <div className="settings-pillar-header">
          <span style={{ fontSize: "1.25rem" }}>{"\uD83D\uDEE1\uFE0F"}</span>
          <h3 className="settings-pillar-title">Pillar 3: Redundancy, Storage &amp; Updates</h3>
          <span className="settings-pillar-badge">Pillar 3</span>
        </div>
        <p className="muted" style={{ fontSize: "0.83rem", margin: "0 0 1.25rem 0" }}>
          Sovereign offline backup archives, cryptographic software update verification, and fail-safe recovery.
        </p>

        {/* Unified Sovereign Backup Card */}
        <div className="section" style={{ background: "var(--color-bg-secondary, #ffffff)", border: "1px solid var(--color-border, #e2e8f0)", borderRadius: "8px", padding: "1.25rem", marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem", marginBottom: "0.85rem" }}>
            <div>
              <h3 style={{ margin: "0 0 0.35rem 0" }}>{"\uD83D\uDEE1\uFE0F"} Sovereign Data Redundancy &amp; Backup</h3>
              <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                Export or restore encrypted <code>.iyoubackup</code> archives of your vault, contacts, and preferences.
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
              <button
                type="button"
                data-testid="export-backup-btn"
                onClick={handleExportBackup}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
              >
                {"\uD83D\uDCE6"} Export Encrypted Backup (.iyoubackup)
              </button>
              <button
                type="button"
                data-testid="restore-backup-btn"
                onClick={handleRestoreBackup}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
              >
                {"\uD83D\uDCE5"} Restore from .iyoubackup
              </button>
            </div>
          </div>

          {/* Collapsible 3-Guarantees Checklist */}
          <details
            data-testid="redundancy-guarantees-details"
            style={{
              marginTop: "0.75rem",
              background: "var(--color-bg-tertiary, #f8fafc)",
              border: "1px solid var(--color-border, #e2e8f0)",
              borderRadius: "6px",
              padding: "0.6rem 0.85rem",
            }}
          >
            <summary style={{ cursor: "pointer", fontSize: "0.82rem", fontWeight: 600, color: "var(--color-text-secondary, #475569)", userSelect: "none" }}>
              {"\uD83D\uDEE1\uFE0F"} View 3-Path Sovereign Redundancy Guarantees
            </summary>
            <ul
              style={{
                margin: "0.6rem 0 0.2rem 0",
                paddingLeft: "1.25rem",
                fontSize: "0.8rem",
                color: "var(--color-text-secondary, #475569)",
                lineHeight: "1.6",
              }}
            >
              <li>
                <strong>Self-Contained SQLite &amp; Local Encrypted Archive:</strong> Create password-encrypted <code>.iyoubackup</code> snapshots stored safely on local disk or USB drive.
              </li>
              <li>
                <strong>XChaCha20-Poly1305 / AES-256 Passphrase Encryption:</strong> Sovereign end-to-end encryption securing your credentials, contacts, and personal preferences against unauthorized access.
              </li>
              <li>
                <strong>Lossless Multi-Device Portability:</strong> Mirror media blobs to your personal Blossom store (<code>:9002</code>) and sync tamper-evident state across decentralized Nostr relays (<code>:9003</code>).
              </li>
            </ul>
          </details>
        </div>

        {/* Software Updates & Verification */}
        <div className="section" style={{ background: "var(--color-bg-secondary, #ffffff)", border: "1px solid var(--color-border, #e2e8f0)", borderRadius: "8px", padding: "1.25rem", marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.35rem 0" }}>Software Updates &amp; Verification</h3>
          <p className="muted" style={{ marginBottom: "0.85rem", fontSize: "0.82rem" }}>
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
              data-testid="check-updates-btn"
              onClick={handleCheckUpdates}
              disabled={updateChecking}
              className="btn-primary bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg shadow-sm transition-colors"
              style={{
                fontSize: "0.82rem",
                padding: "0.45rem 1rem",
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

        {/* Danger Zone: Wipe & Reset + Binary Rollback */}
        <details
          data-testid="danger-zone-details"
          style={{
            marginTop: "1.25rem",
            border: "1px solid rgba(220, 38, 38, 0.35)",
            borderRadius: "8px",
            padding: "1rem",
            background: "rgba(220, 38, 38, 0.04)",
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.85rem",
              color: "#dc2626",
              userSelect: "none",
            }}
          >
            ⚠️ Danger Zone: Factory Reset &amp; Binary Rollback
          </summary>
          <div
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
              type="button"
              data-testid="regenerate-vault-btn"
              onClick={handleWipeAndReset}
              disabled={isGenerating}
              className="btn-destructive bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium rounded-lg transition-colors"
              style={{
                fontSize: "0.8rem",
                padding: "0.4rem 0.85rem",
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
                data-testid="rollback-btn"
                onClick={() => setShowRollbackConfirm(true)}
                disabled={!hasRollback || rollbackLoading}
                className="btn-destructive bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium rounded-lg transition-colors"
                style={{
                  fontSize: "0.8rem",
                  padding: "0.4rem 0.85rem",
                  cursor: hasRollback ? "pointer" : "not-allowed",
                  opacity: hasRollback ? 1 : 0.6,
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

            {/* Advanced / Legacy Import */}
            <div style={{ marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid rgba(220, 38, 38, 0.2)" }}>
              <details>
                <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.82rem", color: "var(--color-text-secondary, #64748b)" }}>
                  Advanced / Legacy Key Import
                </summary>
                <form onSubmit={handleImport} style={{ marginTop: "0.75rem" }}>
                  <div className="form-group" style={{ marginBottom: "0.6rem" }}>
                    <label style={{ fontSize: "0.78rem" }}>DID</label>
                    <input
                      type="text"
                      value={importDid}
                      onChange={(e) => setImportDid(e.target.value)}
                      placeholder="did:key:..."
                      required
                      style={{ fontSize: "0.8rem" }}
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: "0.6rem" }}>
                    <label style={{ fontSize: "0.78rem" }}>Private Key (Base58)</label>
                    <input
                      type="password"
                      value={importKey}
                      onChange={(e) => setImportKey(e.target.value)}
                      placeholder="Base58 encoded seed"
                      required
                      style={{ fontSize: "0.8rem" }}
                    />
                  </div>
                  <button type="submit" className="btn-secondary" style={{ fontSize: "0.8rem", padding: "0.35rem 0.75rem" }}>
                    Import Key
                  </button>
                </form>
              </details>
            </div>
          </div>
        </details>
      </div>

      {/* ========== Hardened Master Seed Reveal Modal ========== */}
      {showSeedModal && (
        <div className="modal-overlay" data-testid="seed-reveal-modal" onClick={closeSeedModal}>
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
                fontSize: "0.88rem",
                color: "#92400e",
              }}
            >
              <strong>Security Warning:</strong> Never share your master root seed. Anyone with this hex phrase has irrevocable, lifetime ownership of your primary persona and all derived family keys.
            </div>

            {revealedSeed ? (
              <div data-testid="seed-revealed-view">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                  <label style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--color-text-secondary, #475569)" }}>
                    64-Character Master Seed (Hex):
                  </label>
                  <span
                    data-testid="seed-timer-countdown"
                    style={{ fontSize: "0.75rem", color: "#d97706", fontWeight: 600 }}
                  >
                    ⏱️ Auto-hides in {seedRemainingSeconds}s
                  </span>
                </div>
                <pre
                  data-testid="revealed-seed-text"
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
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem" }}>
                  <button
                    type="button"
                    data-testid="copy-master-seed"
                    onClick={handleCopyMasterSeed}
                    className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                    style={{ fontSize: "0.85rem", padding: "0.45rem 0.95rem", display: "flex", alignItems: "center", gap: "0.35rem" }}
                  >
                    <span>{seedCopied ? "\u2713" : "\uD83D\uDCCB"}</span>
                    {seedCopied ? "Copied!" : "Copy Seed"}
                  </button>
                  <button
                    type="button"
                    data-testid="close-seed-modal"
                    onClick={closeSeedModal}
                    className="btn-primary bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg shadow-sm transition-colors"
                    style={{ fontSize: "0.85rem", padding: "0.45rem 1rem" }}
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : isPinProtected ? (
              <div data-testid="seed-pin-challenge">
                <p style={{ fontSize: "0.85rem", color: "#475569", margin: "0 0 1rem 0" }}>
                  App Lock is active. Please enter your 6-digit PIN to authenticate before revealing the master seed.
                </p>
                <div style={{ marginBottom: "1rem" }}>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.35rem" }}>
                    Enter 6-Digit PIN:
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    data-testid="seed-pin-input"
                    value={seedPin}
                    onChange={(e) => {
                      setSeedPin(e.target.value.replace(/\D/g, ""));
                      setSeedPinError(null);
                    }}
                    placeholder="••••••"
                    autoFocus
                    style={{
                      width: "100%",
                      padding: "0.55rem 0.75rem",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "1.1rem",
                      letterSpacing: "0.2em",
                      textAlign: "center",
                      boxSizing: "border-box",
                    }}
                  />
                </div>

                {seedPinError && (
                  <div
                    data-testid="seed-pin-error"
                    style={{
                      marginBottom: "0.75rem",
                      color: "#dc2626",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                    }}
                  >
                    {seedPinError}
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
                  {appPrefs?.app_lock_prf_hash ? (
                    <button
                      type="button"
                      data-testid="seed-biometric-verify"
                      onClick={handleVerifyBiometricsAndReveal}
                      className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                      style={{ fontSize: "0.82rem", padding: "0.45rem 0.85rem" }}
                    >
                      {"\uD83D\uDC64"} Verify with Biometrics
                    </button>
                  ) : <div />}

                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={closeSeedModal}
                      className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                      style={{ fontSize: "0.82rem", padding: "0.45rem 0.85rem" }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      data-testid="seed-pin-submit"
                      onClick={handleVerifyPinAndReveal}
                      disabled={seedPin.length !== 6}
                      className="btn-primary bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg shadow-sm transition-colors"
                      style={{ fontSize: "0.85rem", padding: "0.45rem 1rem" }}
                    >
                      Verify &amp; Reveal
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div data-testid="seed-text-confirm">
                <p style={{ fontSize: "0.85rem", color: "#475569", margin: "0 0 1rem 0" }}>
                  App Lock is not currently configured. To protect against accidental revelation, type the confirmation phrase below:
                </p>
                <div className="form-group" style={{ marginBottom: "1rem" }}>
                  <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.35rem" }}>
                    Type <code>REVEAL MY SEED</code> to confirm:
                  </label>
                  <input
                    type="text"
                    data-testid="seed-confirm-input"
                    value={seedConfirmText}
                    onChange={(e) => setSeedConfirmText(e.target.value)}
                    placeholder="REVEAL MY SEED"
                    style={{
                      width: "100%",
                      padding: "0.55rem 0.75rem",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "0.88rem",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1rem" }}>
                  <button
                    type="button"
                    onClick={closeSeedModal}
                    className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                    style={{ fontSize: "0.82rem", padding: "0.45rem 0.85rem" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="seed-confirm-btn"
                    onClick={executeRevealSeed}
                    disabled={!seedConfirmValid}
                    className="btn-primary bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg shadow-sm transition-colors"
                    style={{
                      fontSize: "0.85rem",
                      padding: "0.45rem 1rem",
                      opacity: seedConfirmValid ? 1 : 0.5,
                      cursor: seedConfirmValid ? "pointer" : "not-allowed",
                    }}
                  >
                    Show Seed
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========== Backup Password Modal ========== */}
      {showBackupPassword && (
        <div className="modal-overlay" data-testid="backup-password-modal" onClick={() => setShowBackupPassword(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "440px" }}>
            <h3>Set Backup Password</h3>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Choose a strong password. This password is required to restore the backup.
            </p>
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                data-testid="backup-password-input"
                value={backupPassword}
                onChange={(e) => setBackupPassword(e.target.value)}
                placeholder="Enter backup password"
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setShowBackupPassword(false)}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-download-backup-btn"
                onClick={executeExport}
                disabled={!backupPassword || backupLoading}
                className="btn-primary bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg shadow-sm transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 1rem" }}
              >
                {backupLoading ? "Encrypting..." : "Export Backup"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Restore Password Modal ========== */}
      {showRestorePassword && (
        <div
          className="modal-overlay"
          data-testid="restore-password-modal"
          onClick={() => {
            setShowRestorePassword(false);
            setPendingRestoreBytes(null);
          }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "440px" }}>
            <h3>Restore Backup</h3>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Enter the password used when this backup was created. This will overwrite your current vault, contacts, and preferences.
            </p>
            <div className="form-group">
              <label>Backup Password</label>
              <input
                type="password"
                data-testid="restore-password-input"
                value={restorePassword}
                onChange={(e) => setRestorePassword(e.target.value)}
                placeholder="Enter backup password"
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => {
                  setShowRestorePassword(false);
                  setPendingRestoreBytes(null);
                }}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-restore-backup-btn"
                onClick={executeRestore}
                disabled={!restorePassword || restoreLoading}
                className="btn-destructive bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 1rem" }}
              >
                {restoreLoading ? "Restoring..." : "Restore & Overwrite"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========== Revoke All Sessions Confirmation Modal ========== */}
      {showRevokeModal && (
        <div
          className="modal-overlay"
          data-testid="kill-switch-modal"
          onClick={() => {
            if (!revokeLoading) setShowRevokeModal(false);
          }}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "480px" }}>
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
            <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setShowRevokeModal(false)}
                disabled={revokeLoading}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="confirm-revoke-sessions-btn"
                onClick={handleConfirmRevoke}
                disabled={revokeLoading}
                className="btn-destructive bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 1rem", fontWeight: 600 }}
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
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "400px" }}>
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
                  className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                  style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={newPin.length !== 6 || confirmPin.length !== 6}
                  className="btn-primary bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg shadow-sm transition-colors"
                  style={{
                    fontSize: "0.85rem",
                    padding: "0.45rem 1rem",
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
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "460px" }}>
            <h3 style={{ color: "#dc2626" }}>Confirm Binary Rollback</h3>
            <p className="muted" style={{ fontSize: "0.85rem", lineHeight: "1.5", marginBottom: "1rem" }}>
              Are you sure you want to replace the current executable with the previous binary snapshot? This will restore the prior version. You should restart the application after rollback.
            </p>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setShowRollbackConfirm(false)}
                disabled={rollbackLoading}
                className="btn-secondary bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 0.9rem" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteRollback}
                disabled={rollbackLoading}
                className="btn-destructive bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium rounded-lg transition-colors"
                style={{ fontSize: "0.85rem", padding: "0.45rem 1rem", fontWeight: 600 }}
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
