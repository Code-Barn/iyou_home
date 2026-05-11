import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function KeysManager() {
    const [activeDid, setActiveDid] = useState<string | null>(null);
    const [importDid, setImportDid] = useState("");
    const [importKey, setImportKey] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchActiveDid();
    }, []);

    const fetchActiveDid = async () => {
        try {
            const did = await invoke<string | null>("get_active_did");
            setActiveDid(did);
            setError(null);
        } catch (err: any) {
            setError(err.toString());
        }
    };

    const handleGenerate = async () => {
        setIsGenerating(true);
        setError(null);
        try {
            await invoke("generate_did");
            await fetchActiveDid();
        } catch (err: any) {
            setError(err.toString());
        } finally {
            setIsGenerating(false);
        }
    };

    const handleImport = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        try {
            await invoke("import_did", {
                did: importDid,
                privateKey: importKey,
            });
            await fetchActiveDid();
            setImportDid("");
            setImportKey("");
        } catch (err: any) {
            setError(err.toString());
        }
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

    return (
        <div className="component-container">
            <h2>Keys Management</h2>
            <div
                className="vault-badge"
                title="Keys are managed securely by the local Rust process"
            >
                🛡️ Vault Mode Active
            </div>

            {error && <div className="error-message">{error}</div>}

            <div className="section active-identity">
                <h3>Active Identity</h3>
                {activeDid ? (
                    <div>
                        <code
                            className="did-display"
                            style={{ marginBottom: "1rem" }}
                        >
                            {activeDid}
                        </code>
                        <button onClick={handleExportDocument}>
                            Export Public DID Document
                        </button>
                        <p
                            style={{
                                fontSize: "0.8rem",
                                color: "#666",
                                marginTop: "0.5rem",
                            }}
                        >
                            Export this to upload to your{" "}
                            <code>.well-known/did.json</code> if upgrading to
                            did:web.
                        </p>
                    </div>
                ) : (
                    <p>No active identity found.</p>
                )}
            </div>

            <div className="section actions">
                <h3>Generate New Identity</h3>
                <button onClick={handleGenerate} disabled={isGenerating}>
                    {isGenerating ? "Generating..." : "Generate did:key"}
                </button>
            </div>

            <div className="section import">
                <h3>Import Identity</h3>
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
        </div>
    );
}
