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

import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  LocalBlobInfo,
  categorizeBlob,
  categoryLabel,
  formatFileSize,
  LoopbackMedia,
  truncateHash,
} from "./BlobGrid";

interface BlobDetailDrawerProps {
  blob: LocalBlobInfo;
  onClose: () => void;
  onDeleted: (sha256: string) => void;
}

function formatTimestamp(ts: number): string {
  if (!ts) return "Unknown";
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return String(ts);
  }
}

export default function BlobDetailDrawer({
  blob,
  onClose,
  onDeleted,
}: BlobDetailDrawerProps) {
  const [copied, setCopied] = useState<"sha" | "url" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loopbackUrl = `http://127.0.0.1:9002/${blob.sha256}`;
  const category = categorizeBlob(blob.mime_type);
  const isImage = category === "images";

  const copy = async (text: string, label: "sha" | "url") => {
    try {
      await writeText(text);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
    }
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await invoke<boolean>("delete_local_blob", { sha256: blob.sha256 });
      onDeleted(blob.sha256);
    } catch (err: any) {
      setError(`Delete failed: ${err.toString()}`);
      setDeleting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(460px, 92vw)",
        background: "#ffffff",
        borderLeft: "1px solid #e5e7eb",
        boxShadow: "-8px 0 24px rgba(0,0,0,0.12)",
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        animation: "slide-in-right 0.18s ease-out",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "1rem 1.25rem",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: "1rem" }}>Blob Details</div>
          <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
            {categoryLabel(category)} · {formatFileSize(blob.size_bytes)} ·{" "}
            {formatTimestamp(blob.created_at)}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "#f3f4f6",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            padding: "0.3rem 0.7rem",
            fontSize: "0.75rem",
            cursor: "pointer",
          }}
        >
          ✕ Close
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "1.25rem" }}>
        {error && <div className="error-message">{error}</div>}

        {/* Preview */}
        <div
          style={{
            height: "220px",
            borderRadius: "8px",
            border: "1px solid #e5e7eb",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f9fafb",
            marginBottom: "1rem",
          }}
        >
          {isImage ? (
            <LoopbackMedia sha={blob.sha256} />
          ) : (
            <span style={{ fontSize: "3rem", opacity: 0.7 }}>
              {category === "video" ? "🎬" : category === "audio" ? "🎵" : "📄"}
            </span>
          )}
        </div>

        {/* Metadata */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div>
            <div style={labelStyle}>SHA-256</div>
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <code
                style={{
                  flex: 1,
                  fontFamily: "monospace",
                  fontSize: "0.72rem",
                  wordBreak: "break-all",
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  borderRadius: "6px",
                  padding: "0.4rem 0.5rem",
                  color: "#374151",
                }}
              >
                {blob.sha256}
              </code>
              <button type="button" onClick={() => copy(blob.sha256, "sha")} style={copyBtnStyle}>
                {copied === "sha" ? "✓ Copied" : "📋"}
              </button>
            </div>
            <div style={{ fontSize: "0.68rem", color: "#9ca3af", marginTop: "0.2rem" }}>
              {truncateHash(blob.sha256, 24, 12)}
            </div>
          </div>

          <div>
            <div style={labelStyle}>Local Loopback URL</div>
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <code
                style={{
                  flex: 1,
                  fontFamily: "monospace",
                  fontSize: "0.72rem",
                  wordBreak: "break-all",
                  background: "#f9fafb",
                  border: "1px solid #e5e7eb",
                  borderRadius: "6px",
                  padding: "0.4rem 0.5rem",
                  color: "#374151",
                }}
              >
                {loopbackUrl}
              </code>
              <button type="button" onClick={() => copy(loopbackUrl, "url")} style={copyBtnStyle}>
                {copied === "url" ? "✓ Copied" : "📋"}
              </button>
            </div>
          </div>

          <div style={metaRowStyle}>
            <span style={labelStyle}>MIME Type</span>
            <span style={{ fontSize: "0.8rem", marginLeft: "auto" }}>{blob.mime_type}</span>
          </div>
          <div style={metaRowStyle}>
            <span style={labelStyle}>Size</span>
            <span style={{ fontSize: "0.8rem", marginLeft: "auto" }}>
              {blob.size_bytes.toLocaleString()} bytes
            </span>
          </div>
          <div style={metaRowStyle}>
            <span style={labelStyle}>Created</span>
            <span style={{ fontSize: "0.8rem", marginLeft: "auto" }}>
              {formatTimestamp(blob.created_at)}
            </span>
          </div>
        </div>
      </div>

      {/* Delete action */}
      <div
        style={{
          padding: "1rem 1.25rem",
          borderTop: "1px solid #e5e7eb",
          display: "flex",
          justifyContent: "flex-end",
          gap: "0.75rem",
          alignItems: "center",
        }}
      >
        {confirmDelete && (
          <span style={{ fontSize: "0.75rem", color: "#b91c1c" }}>
            Permanently delete this blob from disk?
          </span>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          style={{
            background: confirmDelete ? "#dc2626" : "#fff1f2",
            border: "1px solid #fecaca",
            color: confirmDelete ? "white" : "#b91c1c",
            fontWeight: 600,
            fontSize: "0.8rem",
            opacity: deleting ? 0.6 : 1,
          }}
        >
          {deleting
            ? "Deleting..."
            : confirmDelete
              ? "Confirm Delete"
              : "🗑️ Delete Blob"}
        </button>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  color: "#6b7280",
};

const copyBtnStyle: React.CSSProperties = {
  padding: "0.3rem 0.6rem",
  fontSize: "0.75rem",
  background: "#f3f4f6",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const metaRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0.35rem 0",
  borderBottom: "1px solid #f3f4f6",
};