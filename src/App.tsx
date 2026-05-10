import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

// This type should match the Rust enum
type ServiceStatus = "running" | "stopped" | "starting";

const SERVICES = ["Nostr", "Blossom", "IPFS"];

function App() {
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

    return (
        <main className="container">
            <h1>Service Switch Panel</h1>
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
        </main>
    );
}

export default App;
