import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import KeysManager from "./components/KeysManager";
import SovereignSigner from "./components/SovereignSigner";
import "./App.css";

type ServiceStatus = "running" | "stopped" | "starting";
const SERVICES = ["IPFS", "Prosody", "Polly"];

function ServiceSwitchPanel() {
    const [serviceStatus, setServiceStatus] = useState<
        Record<string, ServiceStatus>
    >(
        SERVICES.reduce(
            (acc, service) => {
                acc[service] = "stopped";
                return acc;
            },
            {} as Record<string, ServiceStatus>,
        ),
    );
    const [notification, setNotification] = useState<string | null>(null);

    const handleToggleService = async (name: string) => {
        const currentStatus = serviceStatus[name];
        const action = currentStatus === "running" ? "stop" : "start";

        try {
            const newStatus = await invoke<ServiceStatus>("toggle_service", {
                name,
                action,
            });
            setServiceStatus((prev) => ({ ...prev, [name]: newStatus }));
            if (newStatus === "running" || newStatus === "starting") {
                setNotification(`${name} Service Coming Soon!`);
                setTimeout(() => setNotification(null), 3000);
            }
        } catch (error) {
            console.error(`Failed to toggle service ${name}:`, error);
        }
    };

    return (
        <>
            <h2>Service Switch Panel</h2>
            {notification && (
                <div
                    className="vault-badge"
                    style={{
                        marginBottom: "1rem",
                        backgroundColor: "#fff3cd",
                        color: "#856404",
                        borderColor: "#ffeeba",
                    }}
                >
                    {notification}
                </div>
            )}
            <div className="service-list">
                {SERVICES.map((name) => (
                    <div key={name} className="service-item">
                        <div className="status">
                            <div
                                className={`status-light ${serviceStatus[name]}`}
                                title={serviceStatus[name]}
                            />
                            <span className="service-name">{name}</span>
                        </div>
                        <button onClick={() => handleToggleService(name)}>
                            {serviceStatus[name] === "running"
                                ? "Stop"
                                : "Start"}
                        </button>
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
    );
}

export default App;
