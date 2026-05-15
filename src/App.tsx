import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import KeysManager from "./components/KeysManager";
import SovereignSigner from "./components/SovereignSigner";
import WsSignPopup from "./components/WsSignPopup";
import "./App.css";

type ServiceStatus = "running" | "stopped" | "starting";

interface ServiceInfo {
    name: string;
    port?: number;
    alwaysOn?: boolean;
    comingSoon?: boolean;
}

const SERVICES: ServiceInfo[] = [
    { name: "SigBridge", port: 9001, alwaysOn: true },
    { name: "Blossom", port: 9002 },
    { name: "Nostr", port: 9003 },
    { name: "Chat", port: 5222 },
    { name: "IPFS", comingSoon: true },
    { name: "Polly", comingSoon: true },
];

const AUTO_START_DEFAULTS: Record<string, boolean> = {
    Blossom: true,
    Nostr: true,
    Chat: true,
};

function ServiceSwitchPanel() {
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
            <h2>Service Switch Panel</h2>
            <div className="service-list">
                {SERVICES.map((svc) => (
                    <div key={svc.name} className="service-item">
                        <div className="status">
                            <div
                                className={`status-light ${serviceStatus[svc.name] || "stopped"}`}
                                title={serviceStatus[svc.name] || "stopped"}
                            />
                            <span className="service-name">{svc.name}</span>
                            {svc.port && (
                                <span className="service-port">
                                    :{svc.port}
                                </span>
                            )}
                        </div>
                        <div className="service-actions">
                            {!svc.alwaysOn && !svc.comingSoon && (
                                <label className="autostart-toggle">
                                    <input
                                        type="checkbox"
                                        checked={autoStart[svc.name] ?? AUTO_START_DEFAULTS[svc.name] ?? false}
                                        onChange={(e) => handleAutoStartToggle(svc.name, e.target.checked)}
                                    />
                                    Autostart
                                </label>
                            )}
                            {svc.alwaysOn ? (
                                <span className="always-on-badge">Always On</span>
                            ) : svc.comingSoon ? (
                                <span className="coming-soon-badge">Coming Soon</span>
                            ) : (
                                <button onClick={() => handleToggleService(svc.name)}>
                                    {serviceStatus[svc.name] === "running"
                                        ? "Stop"
                                        : "Start"}
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}

function App() {
    const [activeTab, setActiveTab] = useState<"services" | "keys" | "signer">(
        "services",
    );

    return (
        <>
            <WsSignPopup />
            <main className="container">
                <h1>iYou Home</h1>

                <div className="tabs">
                    <button
                        className={activeTab === "services" ? "active" : ""}
                        onClick={() => setActiveTab("services")}
                    >
                        Services
                    </button>
                    <button
                        className={activeTab === "keys" ? "active" : ""}
                        onClick={() => setActiveTab("keys")}
                    >
                        Keys (Vault)
                    </button>
                    <button
                        className={activeTab === "signer" ? "active" : ""}
                        onClick={() => setActiveTab("signer")}
                    >
                        Signer
                    </button>
                </div>

                <div className="tab-content">
                    {activeTab === "services" && <ServiceSwitchPanel />}
                    {activeTab === "keys" && <KeysManager />}
                    {activeTab === "signer" && <SovereignSigner />}
                </div>
            </main>
        </>
    );
}

export default App;
