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
  const [sourceMode, setSourceMode] = useState<SourceMode>("blossom");
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
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    setLoading(true);
    setFetchError(null);
    setSnapshot(null);
    setAuditResult(null);

    try {
      let data: PollSnapshot | null = null;

      if (sourceMode === "ipfs") {
        const url = `${gateway}${trimmed}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`IPFS fetch failed (${response.status}): ${response.statusText}`);
        }
        data = await response.json();
      } else {
        // Blossom: Try local loopback first, fallback to remote CDN
        const cleanHash = trimmed.toLowerCase();
        const urls = [
          `http://127.0.0.1:9002/${cleanHash}`,
          `http://127.0.0.1:9002/blob/${cleanHash}`,
          `https://cdn.iyou.me/${cleanHash}`,
        ];

        let lastErr: Error | null = null;
        for (const url of urls) {
          try {
            const resp = await fetch(url);
            if (resp.ok) {
              data = await resp.json();
              break;
            }
          } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
          }
        }

        if (!data) {
          throw new Error(
            lastErr?.message || "Could not fetch Blossom snapshot from local daemon or remote CDN.",
          );
        }
      }

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

      {/* Primary: Blossom Snapshot View */}
      <div className="section">
        <h3>1. Blossom Snapshot (BUD-01 Primary Source)</h3>
        <p style={{ fontSize: "0.85rem", color: "var(--color-text-secondary)", marginBottom: "0.75rem" }}>
          Verify civic poll ledgers directly from local Blossom Personal Data Store or remote mesh CDN.
        </p>

        <div className="form-group">
          <label>Blossom SHA-256 Snapshot Hash</label>
          <input
            type="text"
            value={sourceMode === "blossom" ? inputValue : ""}
            onChange={(e) => {
              setSourceMode("blossom");
              setInputValue(e.target.value);
            }}
            placeholder="Paste 64-character SHA-256 snapshot hash"
            style={{
              fontFamily: "monospace",
              fontSize: "0.9rem",
            }}
          />
        </div>

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <button
            onClick={() => {
              setSourceMode("blossom");
              handleFetch();
            }}
            disabled={loading || !inputValue.trim()}
          >
            {loading && sourceMode === "blossom" ? "Fetching..." : "Fetch Blossom Snapshot"}
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

        {/* Legacy IPFS Accordion */}
        <details
          style={{
            marginTop: "1.25rem",
            padding: "0.75rem 1rem",
            background: "#f9fafb",
            borderRadius: "6px",
            border: "1px solid #e5e7eb",
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontWeight: 600,
              fontSize: "0.85rem",
              color: "var(--color-text-secondary)",
            }}
          >
            Legacy IPFS Gateway (Optional Cold Archive)
          </summary>
          <div style={{ marginTop: "0.75rem" }}>
            <div className="form-group">
              <label>IPFS Content Identifier (CID)</label>
              <input
                type="text"
                value={sourceMode === "ipfs" ? inputValue : ""}
                onChange={(e) => {
                  setSourceMode("ipfs");
                  setInputValue(e.target.value);
                }}
                placeholder="bafy... or Qm..."
              />
            </div>

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

            <button
              onClick={() => {
                setSourceMode("ipfs");
                handleFetch();
              }}
              disabled={loading || !inputValue.trim()}
              style={{
                fontSize: "0.85rem",
                marginTop: "0.25rem",
              }}
            >
              {loading && sourceMode === "ipfs" ? "Fetching..." : "Fetch from IPFS"}
            </button>
          </div>
        </details>
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
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
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
              Runs a local SHA-256 Merkle tree computation — zero data leaves your device.
            </span>
          </div>

          {/* Side-by-side Merkle Comparison & Cryptographic Verification Badge */}
          {auditResult && (
            <div
              style={{
                marginTop: "1.25rem",
                borderRadius: "8px",
                padding: "1rem 1.25rem",
                background: auditResult.match ? "#ecfdf5" : "#fef2f2",
                border: auditResult.match
                  ? "2px solid var(--color-success)"
                  : "2px solid var(--color-danger)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "0.75rem",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: "1rem",
                    color: auditResult.match ? "var(--color-success)" : "var(--color-danger)",
                  }}
                >
                  {auditResult.match ? "✓ Cryptographically Verified" : "✗ Integrity Failure (Tampered)"}
                </span>
                <span
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 600,
                    padding: "0.2rem 0.6rem",
                    borderRadius: "999px",
                    background: auditResult.match ? "#d1fae5" : "#fee2e2",
                    color: auditResult.match ? "#065f46" : "#991b1b",
                  }}
                >
                  {auditResult.match ? "Merkle Match" : "Hash Mismatch"}
                </span>
              </div>

              <p style={{ margin: "0 0 1rem", fontSize: "0.88rem", color: "var(--color-text-secondary)" }}>
                {auditResult.match
                  ? `All ${snapshot.votes.length} votes match the published Merkle root. This ballot set is mathematically intact.`
                  : "Computed Merkle root does NOT match the asserted snapshot root. This ballot set may have been modified or tampered with."}
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
                    border: `1px solid ${auditResult.match ? "#a7f3d0" : "#fecaca"}`,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: "0.2rem", color: "var(--color-text-muted)" }}>
                    Asserted Root (Snapshot)
                  </div>
                  <code style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>
                    {snapshot.asserted_merkle_root}
                  </code>
                </div>
                <div
                  style={{
                    padding: "0.6rem 0.75rem",
                    background: "#fff",
                    borderRadius: "6px",
                    border: `1px solid ${auditResult.match ? "#a7f3d0" : "#fecaca"}`,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: "0.2rem", color: "var(--color-text-muted)" }}>
                    Computed Root (Local Audit)
                  </div>
                  <code style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>
                    {auditResult.localRoot}
                  </code>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {!snapshot && !fetchError && !loading && (
        <div className="section">
          <p className="muted">
            Paste a Blossom snapshot SHA-256 hash (or expand Legacy IPFS) to audit a governance
            poll ledger. The ballot records are retrieved and cryptographically Merkle
            verified entirely on your local device.
          </p>
        </div>
      )}
    </div>
  );
}
