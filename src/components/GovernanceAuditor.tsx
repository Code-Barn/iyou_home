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

interface SnapshotVote {
  poll_id: string;
  option_id: string;
  client_signature: string;
  voter_did: string;
  network_timestamp: number;
}

interface PollSnapshot {
  poll_id: string;
  title: string;
  asserted_merkle_root: string;
  votes: SnapshotVote[];
}

type SourceMode = "blossom" | "ipfs";

const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
];

function truncateHash(hash: string, lead = 16, tail = 8): string {
  if (!hash || hash.length <= lead + tail + 3) return hash || "";
  return `${hash.slice(0, lead)}...${hash.slice(-tail)}`;
}

export default function GovernanceAuditor() {
  const [sourceMode, setSourceMode] = useState<SourceMode>("ipfs");
  const [inputValue, setInputValue] = useState("");
  const [gateway, setGateway] = useState(IPFS_GATEWAYS[0]);
  const [snapshot, setSnapshot] = useState<PollSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState<{
    match: boolean;
    localRoot: string;
  } | null>(null);

  const handleFetch = async () => {
    if (!inputValue.trim()) return;
    setLoading(true);
    setFetchError(null);
    setSnapshot(null);
    setAuditResult(null);

    try {
      let url: string;
      if (sourceMode === "ipfs") {
        url = `${gateway}${inputValue.trim()}`;
      } else {
        // Blossom: treat input as SHA-256 hash, fetch via local Blossom gateway
        url = `http://127.0.0.1:9002/blob/${inputValue.trim()}`;
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Fetch failed (${response.status}): ${response.statusText}`,
        );
      }
      const data: PollSnapshot = await response.json();
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
          err instanceof Error ? err.message : "Audit invocation failed",
      });
    } finally {
      setAuditing(false);
    }
  };

  const handleClear = () => {
    setInputValue("");
    setSnapshot(null);
    setFetchError(null);
    setAuditResult(null);
  };

  return (
    <div className="component-container">
      <h2>Governance Auditor</h2>
      <div className="vault-badge">Poll Integrity Verification</div>

      {/* Error banner */}
      {fetchError && <div className="error-message">{fetchError}</div>}

      {/* Mismatch verdict — shown at top for maximum visibility */}
      {auditResult && !auditResult.match && (
        <div
          style={{
            background: "#fef2f2",
            border: "2px solid var(--color-danger)",
            borderRadius: "8px",
            padding: "1rem 1.25rem",
            marginBottom: "1rem",
          }}
        >
          <div
            style={{
              fontWeight: 700,
              fontSize: "1rem",
              color: "var(--color-danger)",
              marginBottom: "0.5rem",
            }}
          >
            Integrity Failure
          </div>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>
            Computed Merkle root does not match the asserted snapshot root.
            This ballot set may have been tampered with.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.75rem",
              fontSize: "0.82rem",
            }}
          >
            <div
              style={{
                padding: "0.6rem 0.75rem",
                background: "#fff",
                borderRadius: "6px",
                border: "1px solid #fecaca",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "0.2rem", color: "var(--color-danger)" }}>
                Asserted Root
              </div>
              <code style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>
                {truncateHash(snapshot?.asserted_merkle_root || "", 24, 12)}
              </code>
            </div>
            <div
              style={{
                padding: "0.6rem 0.75rem",
                background: "#fff",
                borderRadius: "6px",
                border: "1px solid #fecaca",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "0.2rem", color: "var(--color-danger)" }}>
                Computed Root
              </div>
              <code style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>
                {truncateHash(auditResult.localRoot, 24, 12)}
              </code>
            </div>
          </div>
        </div>
      )}

      {/* Source Selector */}
      <div className="section">
        <h3>1. Select Data Source</h3>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <button
            onClick={() => {
              setSourceMode("ipfs");
              handleClear();
            }}
            style={{
              padding: "0.5rem 1rem",
              background: sourceMode === "ipfs" ? "var(--color-primary)" : "#f3f4f6",
              color: sourceMode === "ipfs" ? "#fff" : "var(--color-text-secondary)",
              border: "1px solid",
              borderColor: sourceMode === "ipfs" ? "var(--color-primary)" : "#d1d5db",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            IPFS CID
          </button>
          <button
            onClick={() => {
              setSourceMode("blossom");
              handleClear();
            }}
            style={{
              padding: "0.5rem 1rem",
              background: sourceMode === "blossom" ? "var(--color-primary)" : "#f3f4f6",
              color: sourceMode === "blossom" ? "#fff" : "var(--color-text-secondary)",
              border: "1px solid",
              borderColor: sourceMode === "blossom" ? "var(--color-primary)" : "#d1d5db",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            Blossom Snapshot
          </button>
        </div>

        <div className="form-group">
          <label>
            {sourceMode === "ipfs"
              ? "IPFS Content Identifier (CID)"
              : "Blossom SHA-256 Hash"}
          </label>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={
              sourceMode === "ipfs"
                ? "bafy... or Qm..."
                : "Paste the SHA-256 hash of the BUD-01 snapshot"
            }
          />
        </div>

        {sourceMode === "ipfs" && (
          <div className="form-group">
            <label>IPFS Gateway</label>
            <select
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
            >
              {IPFS_GATEWAYS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <button
            onClick={handleFetch}
            disabled={loading || !inputValue.trim()}
          >
            {loading ? "Fetching..." : "Fetch Snapshot"}
          </button>
          {(snapshot || fetchError) && (
            <button
              onClick={handleClear}
              style={{
                background: "#f3f4f6",
                border: "1px solid #d1d5db",
                color: "var(--color-text-secondary)",
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Snapshot Summary Card */}
      {snapshot && (
        <div className="section">
          <h3>2. Poll Summary</h3>
          <div
            style={{
              background: "#f0f4ff",
              border: "1px solid #c7d2fe",
              borderRadius: "8px",
              padding: "1rem 1.25rem",
              marginBottom: "1rem",
            }}
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: "1.05rem",
                marginBottom: "0.5rem",
                color: "var(--color-text-primary)",
              }}
            >
              {snapshot.title || "Untitled Poll"}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: "0.75rem",
                fontSize: "0.85rem",
              }}
            >
              <div>
                <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Verified Ballots
                </div>
                <div style={{ fontWeight: 700, fontSize: "1.2rem", color: "var(--color-text-primary)" }}>
                  {snapshot.votes.length}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Poll ID
                </div>
                <div style={{ fontWeight: 600, fontSize: "0.85rem", color: "var(--color-text-primary)", wordBreak: "break-all" }}>
                  {snapshot.poll_id}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--color-text-muted)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Asserted Merkle Root
                </div>
                <code style={{ fontSize: "0.78rem", wordBreak: "break-all", color: "var(--color-text-secondary)" }}>
                  {truncateHash(snapshot.asserted_merkle_root, 20, 10)}
                </code>
              </div>
            </div>
          </div>

          {/* Audit Button */}
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <button
              onClick={handleAudit}
              disabled={auditing}
              style={{
                padding: "0.65rem 1.5rem",
                background: "linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%)",
                color: "#fff",
                fontWeight: 700,
                fontSize: "0.9rem",
                boxShadow: "0 2px 6px rgba(30, 27, 75, 0.25)",
              }}
            >
              {auditing ? "Computing..." : "\u26A1 Audit Ballots Locally"}
            </button>
            <span style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
              Runs a local SHA-256 Merkle tree computation — no data leaves your device.
            </span>
          </div>
        </div>
      )}

      {/* Match verdict — shown after snapshot section */}
      {auditResult && auditResult.match && (
        <div
          style={{
            background: "#ecfdf5",
            border: "2px solid var(--color-success)",
            borderRadius: "8px",
            padding: "1rem 1.25rem",
            marginTop: "1rem",
          }}
        >
          <div
            style={{
              fontWeight: 700,
              fontSize: "1rem",
              color: "var(--color-success)",
              marginBottom: "0.25rem",
            }}
          >
            Cryptographically Verified
          </div>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--color-text-secondary)" }}>
            All {snapshot?.votes.length || 0} votes match the published Merkle root.
            This ballot set is mathematically intact.
          </p>
        </div>
      )}

      {/* Empty state */}
      {!snapshot && !fetchError && !loading && (
        <div className="section">
          <p className="muted">
            Paste an IPFS CID or a Blossom snapshot hash to fetch a governance
            poll ledger. The snapshot data is retrieved remotely, then Merkle
            verified entirely on your local device — nothing is sent outward.
          </p>
        </div>
      )}
    </div>
  );
}
