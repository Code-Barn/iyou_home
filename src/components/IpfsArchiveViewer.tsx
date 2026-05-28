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

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface IpfsVoteEntry {
  client_signature: string;
  timestamp: number;
  option: string;
}

interface IpfsPollSnapshot {
  poll_id: string;
  title: string;
  asserted_merkle_root: string;
  votes: IpfsVoteEntry[];
}

const GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];

export default function IpfsArchiveViewer() {
  const [cid, setCid] = useState("");
  const [gateway, setGateway] = useState(GATEWAYS[0]);
  const [snapshot, setSnapshot] = useState<IpfsPollSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState<{
    match: boolean;
    localRoot: string;
  } | null>(null);

  const handleFetch = async () => {
    if (!cid.trim()) return;
    setLoading(true);
    setFetchError(null);
    setSnapshot(null);
    setAuditResult(null);

    try {
      const url = `${gateway}${cid.trim()}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Gateway responded with ${response.status}: ${response.statusText}`,
        );
      }
      const data: IpfsPollSnapshot = await response.json();
      setSnapshot(data);
    } catch (err) {
      setFetchError(
        err instanceof Error ? err.message : "Failed to fetch snapshot",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleAudit = async () => {
    if (!snapshot) return;
    setAuditing(true);
    setAuditResult(null);

    try {
      const localRoot = await invoke<string>("calculate_vote_merkle_root", {
        records: snapshot.votes,
      });
      setAuditResult({
        match: localRoot === snapshot.asserted_merkle_root,
        localRoot,
      });
    } catch (err) {
      setAuditResult({
        match: false,
        localRoot:
          err instanceof Error ? err.message : "audit invocation failed",
      });
    } finally {
      setAuditing(false);
    }
  };

  return (
    <div className="component-container">
      <h2>IPFS Cloud Archive Viewer</h2>
      <div className="vault-badge">📡 Stateless Gateway Audit</div>

      {fetchError && <div className="error-message">{fetchError}</div>}

      {auditResult && !auditResult.match && (
        <div className="error-message">
          <strong>🔴 Root Mismatch</strong>
          <br />
          Local computed root does not match the asserted root from the
          snapshot.
        </div>
      )}

      <div className="section">
        <div className="form-group">
          <label>Content Identifier (CID)</label>
          <input
            type="text"
            value={cid}
            onChange={(e) => setCid(e.target.value)}
            placeholder="bafy... or Qm..."
          />
        </div>
        <div className="form-group">
          <label>Gateway</label>
          <select
            value={gateway}
            onChange={(e) => setGateway(e.target.value)}
          >
            {GATEWAYS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <button onClick={handleFetch} disabled={loading || !cid.trim()}>
          {loading ? "Fetching..." : "Fetch Snapshot"}
        </button>
      </div>

      {snapshot && (
        <>
          <div className="section">
            <h3>Poll: {snapshot.title}</h3>
            <div className="credential-meta">
              <div>
                <strong>poll_id:</strong> {snapshot.poll_id}
              </div>
              <div>
                <strong>asserted_merkle_root:</strong>{" "}
                <code className="did-display">
                  {snapshot.asserted_merkle_root}
                </code>
              </div>
              <div>
                <strong>vote entries:</strong> {snapshot.votes.length}
              </div>
            </div>
            <pre className="json-display">
              {JSON.stringify(snapshot, null, 2)}
            </pre>
          </div>

          <div className="section">
            <h3>Local Cryptographic Audit</h3>
            <button onClick={handleAudit} disabled={auditing}>
              {auditing ? "Computing..." : "Audit Ledger Locally"}
            </button>

            {auditResult && auditResult.match && (
              <div
                className="vault-badge"
                style={{
                  display: "block",
                  marginTop: "1rem",
                  textAlign: "center",
                  fontSize: "1em",
                  padding: "1rem",
                }}
              >
                🟢 Cryptographic Audit Match - Verified Independent History
              </div>
            )}

            {auditResult && !auditResult.match && (
              <div style={{ marginTop: "1rem" }}>
                <p className="error-message">
                  <strong>Computed root:</strong>{" "}
                  <code>{auditResult.localRoot}</code>
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {!snapshot && !fetchError && !loading && (
        <div className="section">
          <p className="muted">
            Enter a CID and select a gateway to fetch a governance snapshot
            from the IPFS network. The snapshot data remains on the cloud
            boundary — no local IPFS node is spawned.
          </p>
        </div>
      )}
    </div>
  );
}
