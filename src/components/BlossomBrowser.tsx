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

import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import BlobGrid, {
  BlobCategory,
  LocalBlobInfo,
  categorizeBlob,
  formatFileSize,
} from "./blossom/BlobGrid";
import BlobDetailDrawer from "./blossom/BlobDetailDrawer";

const FILTERS: { id: BlobCategory; label: string }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "other", label: "Other" },
];

export default function BlossomBrowser() {
  const [blobs, setBlobs] = useState<LocalBlobInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<BlobCategory>("all");
  const [selected, setSelected] = useState<LocalBlobInfo | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await invoke<LocalBlobInfo[]>("list_local_blobs");
      setBlobs(list || []);
    } catch (err: any) {
      console.error("Failed to list local blobs:", err);
      setError(err.toString());
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await invoke<LocalBlobInfo[]>("list_local_blobs");
        if (!cancelled) setBlobs(list || []);
      } catch (err: any) {
        if (!cancelled) {
          console.error("Failed to list local blobs:", err);
          setError(err.toString());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDeleted = (sha256: string) => {
    setBlobs((prev) => prev.filter((b) => b.sha256 !== sha256));
    setSelected(null);
  };

  const totalBytes = blobs.reduce((acc, b) => acc + (b.size_bytes || 0), 0);
  const filteredBlobs =
    filter === "all"
      ? blobs
      : blobs.filter((b) => categorizeBlob(b.mime_type) === filter);

  return (
    <div
      style={{
        marginTop: "1.25rem",
        padding: "1rem 1.25rem",
        borderRadius: "8px",
        background: "#ffffff",
        border: "1px solid #e5e7eb",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "0.75rem",
          marginBottom: "0.75rem",
        }}
      >
        <div>
          <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
            {"\uD83D\uDDBC\uFE0F"} Offline Media Vault
          </div>
          <div
            style={{
              fontSize: "0.8rem",
              color: "#6b7280",
              marginTop: "0.15rem",
            }}
          >
            {loading
              ? "Loading blobs from local Blossom..."
              : `${blobs.length} blob${blobs.length === 1 ? "" : "s"} · ${formatFileSize(totalBytes)} used`}
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button onClick={refresh} disabled={loading} style={{ fontSize: "0.85rem", opacity: loading ? 0.6 : 1 }}>
            {loading ? "\u23F3 Loading\u2026" : "\uD83D\uDD04 Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      {/* Offline category filter */}
      {blobs.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: "0.4rem",
            flexWrap: "wrap",
            marginBottom: "0.9rem",
          }}
        >
          {FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                style={{
                  padding: "0.3rem 0.8rem",
                  fontSize: "0.78rem",
                  borderRadius: "6px",
                  border: `1px solid ${active ? "#2563eb" : "#d1d5db"}`,
                  background: active ? "#2563eb" : "#f9fafb",
                  color: active ? "white" : "#4b5563",
                  fontWeight: 600,
                  cursor: "pointer",
                  boxShadow: active ? "0 1px 3px rgba(37,99,235,0.3)" : "none",
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Grid / Empty state */}
      {!loading && blobs.length === 0 ? (
        <div
          style={{
            padding: "2rem 1.5rem",
            textAlign: "center",
            background: "#f9fafb",
            borderRadius: "8px",
            border: "1px dashed #d1d5db",
            color: "#6b7280",
          }}
        >
          <span style={{ fontSize: "1.75rem", display: "block", marginBottom: "0.4rem" }}>
            {"\uD83D\uDDBC\uFE0F"}
          </span>
          <div style={{ fontWeight: 600, color: "#374151" }}>
            No local media blobs yet
          </div>
          <p style={{ fontSize: "0.85rem", margin: "0.35rem 0 0" }}>
            Blobs mirrored by Sync-to-Home or uploaded to your local Blossom node
            (:9002) will appear here.
          </p>
        </div>
      ) : (
        <BlobGrid blobs={filteredBlobs} onSelect={setSelected} />
      )}

      {/* Inspection drawer */}
      {selected && (
        <BlobDetailDrawer
          blob={selected}
          onClose={() => setSelected(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}