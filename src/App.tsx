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
import GlobalStatusBar from "./components/GlobalStatusBar";
import ServiceSwitchPanel from "./components/ServiceSwitchPanel";
import KeysManager from "./components/KeysManager";
import SovereignSigner from "./components/SovereignSigner";
import TrustAssets from "./components/TrustAssets";
import GovernanceAuditor from "./components/GovernanceAuditor";
import WsSignPopup from "./components/WsSignPopup";
import ProjectZero from "./components/enclave/ProjectZero";
import "./App.css";

type TabId = "enclave" | "assets" | "vault" | "services" | "governance" | "signer";

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
  devOnly?: boolean;
}

const TABS: TabDef[] = [
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

  const visibleTabs = TABS.filter((t) => !t.devOnly || showDevMode);

  return (
    <>
      <WsSignPopup />
      <GlobalStatusBar onNavigateEnclave={() => setActiveTab("enclave")} />

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
          {activeTab === "enclave" && <ProjectZero />}
          {activeTab === "assets" && <TrustAssets />}
          {activeTab === "vault" && <KeysManager />}
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
    </>
  );
}

export default App;
