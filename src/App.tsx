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

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatPeerTarget, PersonaProfile, UserPreferences, VaultStatus } from "./lib/types";
import { inactivityMinutesToMs, loadUserPreferences } from "./lib/appLock";
import AppLockOverlay from "./components/auth/AppLockOverlay";
import FirstRunSeedGate from "./components/auth/FirstRunSeedGate";
import FirstRunGateway from "./components/onboarding/FirstRunGateway";
import GlobalStatusBar from "./components/GlobalStatusBar";
import ServiceSwitchPanel from "./components/ServiceSwitchPanel";
import KeysManager from "./components/KeysManager";
import SovereignSigner from "./components/SovereignSigner";
import TrustAssets from "./components/TrustAssets";
import GovernanceAuditor from "./components/GovernanceAuditor";
import WsSignPopup from "./components/WsSignPopup";
import ProjectZero from "./components/enclave/ProjectZero";
import MessagesTab from "./components/MessagesTab";
import "./App.css";

type TabId =
  | "messages"
  | "enclave"
  | "assets"
  | "vault"
  | "services"
  | "governance"
  | "signer";

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
  devOnly?: boolean;
}

const TABS: TabDef[] = [
  { id: "messages", label: "Messages", icon: "\uD83D\uDCAC" },
  { id: "enclave", label: "Enclave", icon: "\uD83D\uDEE1\uFE0F" },
  { id: "assets", label: "Credentials", icon: "\uD83D\uDCDC" },
  { id: "vault", label: "Vault & Recovery", icon: "\uD83D\uDD11" },
  { id: "services", label: "Services", icon: "\u2699\uFE0F" },
  { id: "governance", label: "Governance Auditor", icon: "\uD83D\uDCCA" },
  { id: "signer", label: "Manual Signer", icon: "\uD83E\uDDEA", devOnly: true },
];

const DEV_MODE_KEY = "iyou_home_dev_mode";

function App() {
  const [activeTab, setActiveTab] = useState<TabId>("enclave");
  const [activeProfile, setActiveProfile] = useState<PersonaProfile | null>(null);
  const [selectedChatPeer, setSelectedChatPeer] = useState<ChatPeerTarget | null>(null);
  const [showDevMode, setShowDevMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DEV_MODE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(DEV_MODE_KEY, String(showDevMode));
    } catch {
      // localStorage unavailable — state-only
    }
  }, [showDevMode]);

  // App-lock / first-run seed-gate state.
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  // Vault lifecycle: null until the boot query resolves.
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  // True while the onboarding gateway is on screen. Stays true across the
  // Create ceremony (when the vault flips to Ready on disk but the user has
  // not yet finished writing down the seed) so the gateway never unmounts
  // mid-ceremony. Cleared by `handleInitialized` after services start.
  const [gatewayActive, setGatewayActive] = useState(false);
  const [isAppLocked, setIsAppLocked] = useState(false);
  const [authSessionValidUntil, setAuthSessionValidUntil] = useState<number>(0);
  const lastActivityRef = useRef<number>(Date.now());

  const isVaultReady = vaultStatus === "Ready";
  const vaultExists = vaultStatus !== null && vaultStatus !== "Uninitialized";
  const showGateway =
    vaultStatus === "Uninitialized" || gatewayActive;

  /** Re-query the vault lifecycle from the backend. */
  const checkVaultStatus = useCallback(async (): Promise<VaultStatus> => {
    const status = await invoke<VaultStatus>("get_vault_status").catch(
      () => "Uninitialized" as VaultStatus,
    );
    setVaultStatus(status);
    setGatewayActive(status === "Uninitialized");
    return status;
  }, []);

  /** Fired by the gateway once the vault is provisioned: start the deferred
   *  daemon fleet (SigBridge + auto-start services) and enter the app. */
  const handleInitialized = useCallback(async () => {
    try {
      await invoke("start_ready_services");
    } catch {
      // Daemons are best-effort and must never block navigation.
    }
    await checkVaultStatus();
  }, [checkVaultStatus]);

  const unlockApp = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIsAppLocked(false);
    const graceMinutes = prefs?.signing_grace_period_minutes ?? 0;
    if (graceMinutes > 0) {
      setAuthSessionValidUntil(Date.now() + graceMinutes * 60 * 1000);
    } else {
      setAuthSessionValidUntil(0);
    }
  }, [prefs?.signing_grace_period_minutes]);

  const handleSeedConfirmed = useCallback(() => {
    setPrefs((prev) => (prev ? { ...prev, seed_backup_confirmed: true } : prev));
  }, []);

  const handleLockPreferencesChange = useCallback(
    (next: UserPreferences) => {
      const wasEnabled = prefs?.app_lock_enabled ?? false;
      setPrefs(next);
      if (next.app_lock_enabled && !wasEnabled) {
        lastActivityRef.current = Date.now();
        setIsAppLocked(true);
        setAuthSessionValidUntil(0);
      } else if (!next.app_lock_enabled) {
        lastActivityRef.current = Date.now();
        setIsAppLocked(false);
        const graceMinutes = next.signing_grace_period_minutes ?? 0;
        if (graceMinutes > 0) {
          setAuthSessionValidUntil(Date.now() + graceMinutes * 60 * 1000);
        } else {
          setAuthSessionValidUntil(0);
        }
      }
    },
    [prefs?.app_lock_enabled],
  );

  // Load active persona / profile on boot
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const active = await invoke<PersonaProfile>("get_active_profile");
        if (mounted && active) {
          setActiveProfile(active);
          return;
        }
      } catch {
        // Fallback for empty or legacy vaults
        try {
          const profiles = await invoke<PersonaProfile[]>("list_profiles");
          if (!mounted || !profiles || profiles.length === 0) return;
          const active =
            profiles.find((p) => p.active === true) ||
            profiles.find((p) => (p.level === 1 || p.derivation_index === 1) && !p.is_system_reserved) ||
            profiles.find((p) => p.level !== 0 && p.derivation_index !== 0) ||
            null;
          if (active) {
            setActiveProfile(active);
          }
        } catch {
          // best-effort
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Listen for active profile changes emitted by the backend
  useEffect(() => {
    let unlistenPromise = listen<PersonaProfile>("profile://changed", (event) => {
      if (event.payload) {
        setActiveProfile(event.payload);
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // Load stored preferences + vault lifecycle once at boot. A greenfield
  // vault ("Uninitialized") never enables the app lock and routes straight to
  // the onboarding gateway.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [loadedPrefs, status] = await Promise.all([
        loadUserPreferences(),
        invoke<VaultStatus>("get_vault_status").catch(
          () => "Uninitialized" as VaultStatus,
        ),
      ]);
      if (!mounted) return;
      setPrefs(loadedPrefs);
      setVaultStatus(status);
      setGatewayActive(status === "Uninitialized");
      const hasVault = status === "Ready";
      const shouldLock =
        hasVault &&
        loadedPrefs.app_lock_enabled &&
        (!!loadedPrefs.app_lock_pin_hash || !!loadedPrefs.app_lock_prf_hash);
      setIsAppLocked(shouldLock);
      if (!shouldLock) {
        const graceMinutes = loadedPrefs.signing_grace_period_minutes ?? 0;
        if (graceMinutes > 0) {
          setAuthSessionValidUntil(Date.now() + graceMinutes * 60 * 1000);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Reset the inactivity clock on any user interaction.
  useEffect(() => {
    const resetActivity = () => {
      lastActivityRef.current = Date.now();
    };
    const events: (keyof WindowEventMap)[] = ["mousemove", "keydown", "touchstart"];
    events.forEach((event) =>
      window.addEventListener(event, resetActivity, { passive: true }),
    );
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (
          prefs?.app_lock_enabled &&
          inactivityMinutesToMs(prefs.inactivity_timeout_minutes) > 0 &&
          Date.now() - lastActivityRef.current >=
            inactivityMinutesToMs(prefs.inactivity_timeout_minutes)
        ) {
          setIsAppLocked(true);
          setAuthSessionValidUntil(0);
        }
        lastActivityRef.current = Date.now();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      events.forEach((event) => window.removeEventListener(event, resetActivity));
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [prefs?.app_lock_enabled, prefs?.inactivity_timeout_minutes]);

  // Listen for the native system tray "Lock Enclave" event.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("app://lock", () => {
      setIsAppLocked(true);
      setAuthSessionValidUntil(0);
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {
      // In web/test environments where Tauri event system is not active
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Prevent default browser right-click context menu in production.
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const isProd =
        import.meta.env.PROD ||
        (globalThis as any).process?.env?.NODE_ENV === "production";
      if (isProd) {
        e.preventDefault();
      }
    };
    window.addEventListener("contextmenu", handleContextMenu);
    return () => window.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  // Periodic inactivity check while the app lock is armed. Only arms for a
  // Ready vault — the onboarding gateway and corrupt state are never locked.
  useEffect(() => {
    if (!prefs?.app_lock_enabled || !isVaultReady) return;
    const timeoutMs = inactivityMinutesToMs(prefs.inactivity_timeout_minutes);
    if (timeoutMs <= 0) return;
    const interval = setInterval(() => {
      if (
        !isAppLocked &&
        Date.now() - lastActivityRef.current >= timeoutMs
      ) {
        setIsAppLocked(true);
        setAuthSessionValidUntil(0);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [prefs?.app_lock_enabled, prefs?.inactivity_timeout_minutes, isVaultReady, isAppLocked]);

  // Keep the backend enclave lock flag in sync with the frontend lock state.
  // This gates external signing at the signature bridge while locked.
  useEffect(() => {
    invoke("set_enclave_locked", { locked: isAppLocked }).catch(() => {});
  }, [isAppLocked]);

  // Cross-tab chat handoff: switch to Messages and focus the given peer.
  const openChat = useCallback((target: ChatPeerTarget) => {
    setSelectedChatPeer(target);
    setActiveTab("messages");
  }, []);

  const visibleTabs = TABS.filter((t) => !t.devOnly || showDevMode);

  // Boot splash while the vault lifecycle query is in flight — avoids
  // flashing the gateway (or the tabs) before the backend answers.
  if (vaultStatus === null) {
    return (
      <div
        data-testid="boot-splash"
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f172a",
          color: "#a5b4fc",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          fontSize: "0.95rem",
        }}
      >
        Initializing sovereign enclave…
      </div>
    );
  }

  // Corrupt vault: a terminal state that must never be silently regenerated.
  // The damaged file was quarantined by the backend; guide the user to their
  // recovery path instead of offering a destructive bootstrap.
  if (vaultStatus === "Corrupt") {
    return (
      <div
        data-testid="corrupt-vault-screen"
        style={{
          position: "fixed",
          inset: 0,
          overflow: "auto",
          background:
            "linear-gradient(160deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "3rem 1.5rem",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          color: "#e0e7ff",
        }}
      >
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(199, 210, 254, 0.2)",
            borderRadius: "16px",
            padding: "2rem",
            maxWidth: "680px",
            width: "100%",
          }}
        >
          <h2 style={{ margin: "0 0 0.5rem 0", color: "#fff" }}>
            ⚠️ Vault Corrupted
          </h2>
          <p style={{ fontSize: "0.95rem", color: "#c7d2fe", lineHeight: 1.6 }}>
            Your vault file could not be loaded and was quarantined to a
            <code> .corrupt_*.bak </code> backup rather than being destroyed.
            Your identity has <strong>not</strong> been regenerated.
          </p>
          <p style={{ fontSize: "0.9rem", color: "#c7d2fe", lineHeight: 1.6 }}>
            Restore from an encrypted <strong>.iyoubackup</strong> archive or
            your written master seed on a fresh install. If you need
            assistance, keep your seed phrase and backup files safe and contact
            support.
          </p>
        </div>
      </div>
    );
  }

  // First-run onboarding gateway: no tabs, no status bar, no daemons. The
  // gateway stays mounted through the seed ceremony until `onInitialized`.
  if (showGateway) {
    return (
      <>
        <FirstRunGateway
          onInitialized={() => {
            void handleInitialized();
          }}
        />
        {isAppLocked && (
          <AppLockOverlay
            pinHash={prefs?.app_lock_pin_hash ?? null}
            prfHash={prefs?.app_lock_prf_hash ?? null}
            autoLockMinutes={prefs?.inactivity_timeout_minutes ?? 15}
            onUnlock={unlockApp}
          />
        )}
      </>
    );
  }

  return (
    <>
      <WsSignPopup
        isAppLocked={isAppLocked}
        authSessionValidUntil={authSessionValidUntil}
      />
      <GlobalStatusBar
        onNavigateEnclave={() => setActiveTab("enclave")}
        activeProfile={activeProfile}
        setActiveProfile={setActiveProfile}
      />

      <main className="container">
        <div className="tabs">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        <div className="tab-content">
          {activeTab === "messages" && (
            <MessagesTab
              initialPeer={selectedChatPeer}
              onClearInitialPeer={() => setSelectedChatPeer(null)}
            />
          )}
          {activeTab === "enclave" && (
            <ProjectZero
              onRequestChat={openChat}
              activeProfile={activeProfile}
              setActiveProfile={setActiveProfile}
            />
          )}
          {activeTab === "assets" && <TrustAssets />}
          {activeTab === "vault" && (
            <KeysManager
              prefs={prefs}
              onLockSettingsChange={handleLockPreferencesChange}
              activeProfile={activeProfile}
              setActiveProfile={setActiveProfile}
            />
          )}
          {activeTab === "services" && <ServiceSwitchPanel />}
          {activeTab === "governance" && <GovernanceAuditor />}
          {activeTab === "signer" && showDevMode && (
            <SovereignSigner activeProfile={activeProfile} />
          )}
        </div>

        {/* Footer with Dev Mode Toggle */}
        <div className="app-footer">
          <label className="dev-mode-toggle">
            <input
              type="checkbox"
              checked={showDevMode}
              onChange={(e) => setShowDevMode(e.target.checked)}
            />
            Developer Mode
          </label>
        </div>
      </main>

      {/* App Lock Overlay */}
      {isAppLocked && (
        <AppLockOverlay
          pinHash={prefs?.app_lock_pin_hash ?? null}
          prfHash={prefs?.app_lock_prf_hash ?? null}
          autoLockMinutes={prefs?.inactivity_timeout_minutes ?? 15}
          onUnlock={unlockApp}
        />
      )}

      {/* First-Run Master Seed Confirmation Gate (legacy vaults that predate
          the onboarding gateway; the gateway itself completes this ceremony) */}
      {!isAppLocked && !showGateway && vaultExists && prefs && !prefs.seed_backup_confirmed && (
        <FirstRunSeedGate onConfirmed={handleSeedConfirmed} />
      )}
    </>
  );
}

export default App;
