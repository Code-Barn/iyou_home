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

export interface LocalBlobInfo {
  sha256: string;
  size_bytes: number;
  mime_type: string;
  created_at: number;
}

export type BlobCategory = "all" | "images" | "video" | "audio" | "other";

export function truncateHash(hash: string, lead = 10, tail = 6): string {
  if (!hash) return "";
  if (hash.length <= lead + tail + 3) return hash;
  return `${hash.slice(0, lead)}...${hash.slice(-tail)}`;
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, idx);
  return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function categorizeBlob(mime: string): Exclude<BlobCategory, "all"> {
  const norm = String(mime || "").toLowerCase();
  if (norm.startsWith("image/")) return "images";
  if (norm.startsWith("video/")) return "video";
  if (norm.startsWith("audio/")) return "audio";
  return "other";
}

export function categoryLabel(category: Exclude<BlobCategory, "all">): string {
  switch (category) {
    case "images":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    default:
      return "File";
  }
}

/** Prefer a live loopback render when the blob is an image, otherwise a
 *  lightweight file-type placeholder. Loading directly from the Blossom
 *  daemon keeps the UI fully offline. */
export function LoopbackMedia({ sha }: { sha: string }) {
  const src = `http://127.0.0.1:9002/${sha}`;
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f1f5f9",
          color: "#94a3b8",
          fontSize: "0.75rem",
          textAlign: "center",
          padding: "0.5rem",
          boxSizing: "border-box",
        }}
      >
        Preview unavailable
      </div>
    );
  }

  return (
    <img
      src={src}
      alt="blob preview"
      loading="lazy"
      onError={() => setFailed(true)}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
        background: "#f1f5f9",
      }}
    />
  );
}

interface BlobGridProps {
  blobs: LocalBlobInfo[];
  onSelect: (blob: LocalBlobInfo) => void;
}

export default function BlobGrid({ blobs, onSelect }: BlobGridProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns:
          "repeat(auto-fill, minmax(150px, 1fr))",
        gap: "0.75rem",
      }}
    >
      {blobs.map((blob) => {
        const category = categorizeBlob(blob.mime_type);
        const isImage = category === "images";
        return (
          <button
            key={blob.sha256}
            type="button"
            onClick={() => onSelect(blob)}
            title={blob.sha256}
            style={{
              padding: 0,
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
              background: "white",
              overflow: "hidden",
              cursor: "pointer",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            }}
          >
            <div
              style={{
                height: "110px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#f9fafb",
                overflow: "hidden",
              }}
            >
              {isImage ? (
                <LoopbackMedia sha={blob.sha256} />
              ) : (
                <span
                  style={{
                    fontSize: "2rem",
                    opacity: 0.7,
                  }}
                >
                  {category === "video" ? "🎬" : category === "audio" ? "🎵" : "📄"}
                </span>
              )}
            </div>
            <div
              style={{
                padding: "0.5rem 0.6rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.25rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span
                  style={{
                    padding: "0.05rem 0.4rem",
                    borderRadius: "10px",
                    fontSize: "0.65rem",
                    fontWeight: 600,
                    background: "#ede9fe",
                    color: "#6d28d9",
                    border: "1px solid #ddd6fe",
                    whiteSpace: "nowrap",
                  }}
                >
                  {categoryLabel(category)}
                </span>
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    color: "#4b5563",
                    marginLeft: "auto",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatFileSize(blob.size_bytes)}
                </span>
              </div>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "0.68rem",
                  color: "#6b7280",
                  wordBreak: "break-all",
                }}
              >
                {truncateHash(blob.sha256)}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}