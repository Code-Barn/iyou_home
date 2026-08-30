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
import type { ChatPeerTarget, PersonaProfile, UserPreferences } from "./lib/types";
import { inactivityMinutesToMs, loadUserPreferences } from "./lib/appLock";
import AppLockOverlay from "./components/auth/AppLockOverlay";
import FirstRunSeedGate from "./components/auth/FirstRunSeedGate";
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
  const [vaultExists, setVaultExists] = useState(false);
  const [isAppLocked, setIsAppLocked] = useState(false);
  const lastActivityRef = useRef<number>(Date.now());

  const unlockApp = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIsAppLocked(false);
  }, []);

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
      } else if (!next.app_lock_enabled) {
        lastActivityRef.current = Date.now();
        setIsAppLocked(false);
      }
    },
    [prefs?.app_lock_enabled],
  );

  // Load active persona / profile on boot
  useEffect(() => {
    let mounted = true;
    (async () => {
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

  // Load stored preferences + vault existence once at boot.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [loadedPrefs, hasVault] = await Promise.all([
        loadUserPreferences(),
        invoke<boolean>("get_vault_status").catch(() => false),
      ]);
      if (!mounted) return;
      setPrefs(loadedPrefs);
      setVaultExists(hasVault === true);
      setIsAppLocked(
        hasVault === true &&
          loadedPrefs.app_lock_enabled &&
          (!!loadedPrefs.app_lock_pin_hash || !!loadedPrefs.app_lock_prf_hash),
      );
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

  // Periodic inactivity check while the app lock is armed.
  useEffect(() => {
    if (!prefs?.app_lock_enabled || !vaultExists) return;
    const timeoutMs = inactivityMinutesToMs(prefs.inactivity_timeout_minutes);
    if (timeoutMs <= 0) return;
    const interval = setInterval(() => {
      if (
        !isAppLocked &&
        Date.now() - lastActivityRef.current >= timeoutMs
      ) {
        setIsAppLocked(true);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [prefs?.app_lock_enabled, prefs?.inactivity_timeout_minutes, vaultExists, isAppLocked]);

  // Cross-tab chat handoff: switch to Messages and focus the given peer.
  const openChat = useCallback((target: ChatPeerTarget) => {
    setSelectedChatPeer(target);
    setActiveTab("messages");
  }, []);

  const visibleTabs = TABS.filter((t) => !t.devOnly || showDevMode);

  return (
    <>
      <WsSignPopup />
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
          {activeTab === "signer" && showDevMode && <SovereignSigner />}
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

      {/* First-Run Master Seed Confirmation Gate */}
      {!isAppLocked && vaultExists && prefs && !prefs.seed_backup_confirmed && (
        <FirstRunSeedGate onConfirmed={handleSeedConfirmed} />
      )}
    </>
  );
}

export default App;
