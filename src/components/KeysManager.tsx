/*
 * Copyright (C) 2026 Byers Brands, LLC
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
import { invoke } from "@tauri-apps/api/core";

interface Profile {
  profile_id: string;
  profile_name: string;
  derivation_index: number;
  did: string;
}

function truncateDid(did: string, chars = 24): string {
  if (did.length <= chars + 6) return did;
  return did.slice(0, chars) + "..." + did.slice(-6);
}

export default function KeysManager() {
  const [activeDid, setActiveDid] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [importDid, setImportDid] = useState("");
  const [importKey, setImportKey] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchActiveDid();
    fetchProfiles();
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

  const fetchProfiles = async () => {
    try {
      const list = await invoke<Profile[]>("list_profiles");
      setProfiles(list);
    } catch (err: any) {
      console.error("Failed to list profiles:", err);
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      await invoke("generate_did");
      await fetchActiveDid();
      await fetchProfiles();
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
      await fetchProfiles();
      setImportDid("");
      setImportKey("");
    } catch (err: any) {
      setError(err.toString());
    }
  };

  const handleAddProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileName.trim()) return;
    setError(null);
    try {
      await invoke("add_profile", { profileName: newProfileName.trim() });
      setNewProfileName("");
      await fetchActiveDid();
      await fetchProfiles();
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
          </div>
        ) : (
          <p>No active identity found.</p>
        )}
      </div>

      <div className="section">
        <h3>Personas ({profiles.length})</h3>
        {profiles.length === 0 ? (
          <p className="muted">No personas configured.</p>
        ) : (
          <div className="profile-list">
            {profiles.map((p) => (
              <div
                key={p.profile_id}
                className={`profile-item ${
                  p.did === activeDid ? "profile-active" : ""
                }`}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.5rem 0.75rem",
                  margin: "0.25rem 0",
                  borderRadius: "6px",
                  background:
                    p.did === activeDid ? "#e8f5e9" : "transparent",
                  border:
                    p.did === activeDid
                      ? "1px solid #4caf50"
                      : "1px solid #e0e0e0",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                    {p.profile_name}
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "#666",
                      fontFamily: "monospace",
                    }}
                    title={p.did}
                  >
                    {truncateDid(p.did)}
                  </div>
                </div>
                <div style={{ fontSize: "0.7rem", color: "#999" }}>
                  #{p.derivation_index}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section actions">
        <h3>Generate New Vault</h3>
        <button onClick={handleGenerate} disabled={isGenerating}>
          {isGenerating ? "Generating..." : "Generate did:key"}
        </button>
      </div>

      <div className="section">
        <h3>Add Persona</h3>
        <form onSubmit={handleAddProfile}>
          <div className="form-group">
            <label>Persona Name</label>
            <input
              type="text"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              placeholder='e.g. "Social Pseudonym"'
              required
            />
          </div>
          <button type="submit">Create Persona</button>
        </form>
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
