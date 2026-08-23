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
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export default function KeysManager() {
  const [activeDid, setActiveDid] = useState<string | null>(null);
  const [importDid, setImportDid] = useState("");
  const [importKey, setImportKey] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const handleCopyDid = async () => {
    if (!activeDid) return;
    try {
      await writeText(activeDid);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        await navigator.clipboard.writeText(activeDid);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (e: any) {
        setError(`Clipboard copy failed: ${e.toString()}`);
      }
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
      <h2>Vault Backup &amp; Identity Recovery</h2>
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
            <code className="did-display" style={{ marginBottom: "1rem" }}>
              {activeDid}
            </code>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              <button onClick={handleCopyDid}>
                {copied ? "✓ Copied" : "📋 Copy DID"}
              </button>
              <button onClick={handleExportDocument}>
                Export Public DID Document
              </button>
            </div>
          </div>
        ) : (
          <p>No active identity found.</p>
        )}
      </div>

      <div className="section actions">
        <h3>New Vault Bootstrap</h3>
        <p className="muted">
          Derives a fresh root seed with the full dual-identity hierarchy
          (Level 0 Anchor + Level 1 Public Persona). Only use this when no
          vault exists — existing keys are never overwritten.
        </p>
        <button onClick={handleGenerate} disabled={isGenerating}>
          {isGenerating ? "Generating..." : "Generate did:key"}
        </button>
      </div>

      <div className="section import">
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

      <div
        className="section"
        style={{
          borderLeft: "4px solid #4338ca",
          background: "rgba(67, 56, 202, 0.05)",
          padding: "1rem",
          borderRadius: "6px",
        }}
      >
        <h3 style={{ marginTop: 0 }}>🛡️ Multi-Persona Management</h3>
        <p className="muted" style={{ marginBottom: 0 }}>
          Persona creation, burner identities, active-profile switching, and
          contact trust settings have moved to the{" "}
          <strong>Project Zero (Enclave 🛡️)</strong> tab. Open the Persona
          Matrix there to manage your full identity hierarchy.
        </p>
      </div>
    </div>
  );
}
