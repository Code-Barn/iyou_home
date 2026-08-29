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

export interface EcosystemFootprint {
  social_notes_count: number;
  governance_ballots_count: number;
  evidence_records_count: number;
  kinship_entries_count: number;
  media_blobs_count: number;
  media_storage_bytes: number;
  registered_ledgers_count: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function SovereignFootprint() {
  const [footprint, setFootprint] = useState<EcosystemFootprint | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchFootprint = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<EcosystemFootprint>("get_ecosystem_footprint");
      setFootprint(data);
    } catch (err) {
      console.error("Failed to load ecosystem footprint:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFootprint();
  }, [fetchFootprint]);

  const cards = [
    {
      title: "Social Footprint",
      app: "iyou_wun",
      icon: "🌐",
      count: footprint?.social_notes_count ?? 0,
      label: "Notes & Timeline Events",
      url: "https://wun.iyou.me",
      color: "#3b82f6",
      bg: "#eff6ff",
      border: "#bfdbfe",
    },
    {
      title: "Governance Footprint",
      app: "iyou_poly",
      icon: "🗳️",
      count: footprint?.governance_ballots_count ?? 0,
      label: "Audited Ballots & Polls",
      url: "https://poly.iyou.me",
      color: "#8b5cf6",
      bg: "#f5f3ff",
      border: "#ddd6fe",
    },
    {
      title: "Evidence Vault",
      app: "iyou_hive",
      icon: "🛡️",
      count: footprint?.evidence_records_count ?? 0,
      label: "Cases & Encrypted Records",
      url: "https://hive.iyou.me",
      color: "#10b981",
      bg: "#ecfdf5",
      border: "#a7f3d0",
    },
    {
      title: "Kinship Registry",
      app: "iyou_name",
      icon: "👥",
      count: footprint?.kinship_entries_count ?? 0,
      label: "Family Lineage Entries",
      url: "https://name.iyou.me",
      color: "#f59e0b",
      bg: "#fffbeb",
      border: "#fde68a",
    },
    {
      title: "Media Vault",
      app: "Blossom (BUD-01)",
      icon: "🌸",
      count: footprint?.media_blobs_count ?? 0,
      label: `Local Blobs (${formatBytes(footprint?.media_storage_bytes ?? 0)})`,
      url: "http://127.0.0.1:9002",
      color: "#ec4899",
      bg: "#fdf2f8",
      border: "#fbcfe8",
    },
  ];

  return (
    <div style={{ marginTop: "1.5rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.85rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: "1.05rem", color: "#1e293b" }}>
            🏛️ Sovereign Ecosystem Footprint
          </h3>
          <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "0.15rem" }}>
            Local Personal Data Store metrics & satellite mesh anchors · {footprint?.registered_ledgers_count ?? 0} registered ledgers
          </div>
        </div>
        <button
          onClick={fetchFootprint}
          disabled={loading}
          style={{
            background: "transparent",
            border: "1px solid #cbd5e1",
            borderRadius: "6px",
            padding: "0.35rem 0.75rem",
            fontSize: "0.8rem",
            color: "#475569",
            cursor: "pointer",
          }}
        >
          {loading ? "Refreshing…" : "🔄 Refresh"}
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "0.85rem",
        }}
      >
        {cards.map((c) => (
          <div
            key={c.title}
            style={{
              background: c.bg,
              border: `1px solid ${c.border}`,
              borderRadius: "10px",
              padding: "1rem",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              transition: "transform 0.15s, box-shadow 0.15s",
            }}
          >
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "0.5rem",
                }}
              >
                <span style={{ fontSize: "1.3rem" }}>{c.icon}</span>
                <span
                  style={{
                    fontSize: "0.72rem",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: c.color,
                    background: "rgba(255,255,255,0.7)",
                    padding: "0.15rem 0.45rem",
                    borderRadius: "4px",
                  }}
                >
                  {c.app}
                </span>
              </div>
              <div style={{ fontWeight: 700, fontSize: "0.92rem", color: "#1e293b" }}>
                {c.title}
              </div>
              <div style={{ fontSize: "1.4rem", fontWeight: 800, color: c.color, margin: "0.35rem 0" }}>
                {c.count}
              </div>
              <div style={{ fontSize: "0.78rem", color: "#64748b" }}>{c.label}</div>
            </div>

            <div style={{ marginTop: "0.85rem", paddingTop: "0.65rem", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
              <a
                href={c.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  fontSize: "0.78rem",
                  fontWeight: 600,
                  color: c.color,
                  textDecoration: "none",
                }}
              >
                Launch Satellite Portal ↗
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
