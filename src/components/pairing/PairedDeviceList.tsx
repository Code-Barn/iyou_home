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

import { invoke } from "@tauri-apps/api/core";
import type { CSSProperties } from "react";

export interface PairedDeviceRecord {
  device_id: string;
  device_did: string;
  device_name: string;
  paired_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export function formatPairedDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function truncateDid(did: string, head = 16, tail = 8): string {
  if (did.length <= head + tail) return did;
  return `${did.slice(0, head)}…${did.slice(-tail)}`;
}

interface Props {
  devices: PairedDeviceRecord[];
  onChanged: () => void;
}

export default function PairedDeviceList({ devices, onChanged }: Props) {
  const activeCount = devices.filter((d) => !d.revoked_at).length;

  if (devices.length === 0) {
    return (
      <p
        style={{
          fontSize: "0.83rem",
          color: "var(--color-text-muted)",
          margin: 0,
          padding: "0.75rem 0",
        }}
      >
        No paired devices yet. Pair a mobile companion to mirror seed-encrypted
        identity frames to it over a local network.
      </p>
    );
  }

  const handleRevoke = (device: PairedDeviceRecord) => {
    const confirmed = window.confirm(
      `Revoke "${device.device_name}"? It will immediately lose the ability to receive future sealed seed frames from this vault.`
    );
    if (!confirmed) return;
    invoke("pair_revoke_device", { deviceId: device.device_id })
      .then(() => onChanged())
      .catch((err: unknown) => {
        window.alert(`Revocation failed: ${err}`);
      });
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.83rem" }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th style={thStyle}>Device Name</th>
            <th style={thStyle}>Device DID</th>
            <th style={thStyle}>Paired</th>
            <th style={thStyle}>Status</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => {
            const revoked = Boolean(d.revoked_at);
            return (
              <tr key={d.device_id} style={{ borderTop: "1px solid var(--color-border, #e5e7eb)" }}>
                <td style={tdStyle}>
                  <span style={{ fontWeight: 600 }}>{d.device_name}</span>
                  <span
                    style={{
                      display: "block",
                      fontSize: "0.72rem",
                      color: "var(--color-text-muted)",
                    }}
                  >
                    {d.device_id.slice(0, 8)}
                  </span>
                </td>
                <td style={tdStyle}>
                  <span
                    title={d.device_did}
                    style={{ fontFamily: "var(--font-mono, monospace)" }}
                  >
                    {truncateDid(d.device_did)}
                  </span>
                </td>
                <td style={tdStyle}>{formatPairedDate(d.paired_at)}</td>
                <td style={tdStyle}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "2px 8px",
                      borderRadius: "999px",
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      color: revoked ? "#6b7280" : "#137333",
                      background: revoked ? "#f3f4f6" : "#e7f6ec",
                    }}
                  >
                    {revoked ? "Revoked" : "Active"}
                  </span>
                </td>
                <td style={{ ...tdStyle, textAlign: "right" }}>
                  {revoked ? (
                    <span style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}>
                      {formatPairedDate(d.revoked_at || 0)} · prevented from re-sealing
                    </span>
                  ) : (
                    <button
                      onClick={() => handleRevoke(d)}
                      style={{
                        background: "transparent",
                        border: "1px solid #dc2626",
                        color: "#dc2626",
                        fontSize: "0.78rem",
                        padding: "4px 10px",
                        fontWeight: 600,
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p
        style={{
          fontSize: "0.75rem",
          color: "var(--color-text-muted)",
          margin: "0.5rem 0 0 0",
        }}
      >
        {activeCount} active · {devices.length - activeCount} revoked
      </p>
    </div>
  );
}

const thStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  fontWeight: 600,
  color: "var(--color-text-secondary, #475569)",
  borderBottom: "2px solid var(--color-border, #e5e7eb)",
};

const tdStyle: CSSProperties = {
  padding: "0.65rem 0.75rem",
  verticalAlign: "middle",
};