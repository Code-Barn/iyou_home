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
  safe_beacons_count?: number;
  talk_rooms_count?: number;
  clar_entries_count?: number;
  draw_manifests_count?: number;
  ride_ledger_count?: number;
  stay_manifests_count?: number;
  farm_ledger_count?: number;
  blog_posts_count?: number;
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
  const [showExtended, setShowExtended] = useState(false);

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

  // Core 8 Satellite Matrix (2x4 Grid)
  const coreCards = [
    {
      title: "Social Footprint",
      app: "iyou_wun",
      icon: "🌐",
      count: footprint?.social_notes_count ?? 0,
      label: "Notes & Timeline Events",
      url: "https://wun.iyou.me",
      color: "#2563eb",
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
      color: "#7c3aed",
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
      color: "#059669",
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
      color: "#d97706",
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
      color: "#db2777",
      bg: "#fdf2f8",
      border: "#fbcfe8",
    },
    {
      title: "Safety Circles & Beacons",
      app: "iyou_safe",
      icon: "🚨",
      count: footprint?.safe_beacons_count ?? 0,
      label: "Emergency & Kinship Beacons",
      url: "https://safe.iyou.me",
      color: "#e11d48",
      bg: "#fff1f2",
      border: "#fecdd3",
    },
    {
      title: "Support Rooms & Journals",
      app: "iyou_talk",
      icon: "💬",
      count: footprint?.talk_rooms_count ?? 0,
      label: "Mental Health & Peer Rooms",
      url: "https://talk.iyou.me",
      color: "#0284c7",
      bg: "#f0f9ff",
      border: "#bae6fd",
    },
    {
      title: "Creator Bookmarks & Ranks",
      app: "iyou_clar",
      icon: "⭐",
      count: footprint?.clar_entries_count ?? 0,
      label: "Curated Knowledge & Ranks",
      url: "https://clar.iyou.me",
      color: "#10b981",
      bg: "#f0fdf4",
      border: "#bbf7d0",
    },
  ];

  // Extended Mesh Satellites (+5)
  const extendedCards = [
    {
      title: "Vector Canvas & Art",
      app: "iyou_draw",
      icon: "🎨",
      count: footprint?.draw_manifests_count ?? 0,
      label: "Drawings & Manifests",
      url: "https://draw.iyou.me",
      color: "#ea580c",
      bg: "#fff7ed",
      border: "#ffedd5",
    },
    {
      title: "P2P Mobility & Fleet",
      app: "iyou_ride",
      icon: "🚗",
      count: footprint?.ride_ledger_count ?? 0,
      label: "Rides & Transit Logs",
      url: "https://ride.iyou.me",
      color: "#0d9488",
      bg: "#f0fdfa",
      border: "#ccfbf1",
    },
    {
      title: "Local Havens & Sanctuaries",
      app: "iyou_stay",
      icon: "🏡",
      count: footprint?.stay_manifests_count ?? 0,
      label: "Sanctuaries & Bookings",
      url: "https://stay.iyou.me",
      color: "#8b5cf6",
      bg: "#f5f3ff",
      border: "#ede9fe",
    },
    {
      title: "Harvest Direct Commons",
      app: "iyou_farm",
      icon: "🌾",
      count: footprint?.farm_ledger_count ?? 0,
      label: "Produce & Farm Shares",
      url: "https://farm.iyou.me",
      color: "#65a30d",
      bg: "#f7fee7",
      border: "#d9f99d",
    },
    {
      title: "Long-Form Publishing",
      app: "iyou_blog",
      icon: "📰",
      count: footprint?.blog_posts_count ?? 0,
      label: "Articles & Blog Essays",
      url: "https://blog.iyou.me",
      color: "#475569",
      bg: "#f8fafc",
      border: "#e2e8f0",
    },
  ];

  return (
    <div style={{ marginTop: "1.5rem" }}>
      {/* Header bar */}
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
            Local Personal Data Store metrics &amp; satellite mesh anchors · {footprint?.registered_ledgers_count ?? 0} registered ledgers
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => setShowExtended(!showExtended)}
            style={{
              background: showExtended ? "#e0e7ff" : "#f1f5f9",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              padding: "0.35rem 0.75rem",
              fontSize: "0.8rem",
              fontWeight: 600,
              color: showExtended ? "#3730a3" : "#475569",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {showExtended ? "▴ Collapse Extended Mesh" : "▾ Extended Mesh (+5)"}
          </button>

          <button
            type="button"
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
      </div>

      {/* Core 8 Grid (2x4) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "0.85rem",
        }}
      >
        {coreCards.map((c) => (
          <div
            key={c.app}
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

      {/* Expandable Extended Mesh Drawer */}
      {showExtended && (
        <div
          style={{
            marginTop: "1.25rem",
            paddingTop: "1rem",
            borderTop: "1px dashed #cbd5e1",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <span style={{ fontSize: "1.1rem" }}>🌌</span>
            <span style={{ fontWeight: 700, fontSize: "0.95rem", color: "#334155" }}>
              Extended Mesh Ecosystem (+5 Satellites)
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: "0.85rem",
            }}
          >
            {extendedCards.map((c) => (
              <div
                key={c.app}
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
      )}
    </div>
  );
}
