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

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import PairedDeviceList, { PairedDeviceRecord } from "./pairing/PairedDeviceList";
import PairQrModal from "./pairing/PairQrModal";

export default function DevicePairing() {
  const [devices, setDevices] = useState<PairedDeviceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPairModal, setShowPairModal] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<PairedDeviceRecord[]>("pair_list_devices");
      setDevices(Array.isArray(list) ? list : []);
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reflect backend-driven pairings (real mobile handshake) into the list.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<PairedDeviceRecord>("pair://status", () => {
      if (!cancelled) void refresh();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  const activeCount = devices.filter((d) => !d.revoked_at).length;

  return (
    <div
      className="section"
      style={{
        border: "1px solid #bfdbfe",
        background: "#eff6ff",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          justifyContent: "space-between",
          flexWrap: "wrap",
        }}
      >
        <h3 style={{ margin: 0 }}>
          {"\uD83D\uDCF1"} Mobile Device Pairing{" "}
          <span
            style={{
              display: "inline-block",
              padding: "2px 10px",
              borderRadius: "999px",
              fontSize: "0.75rem",
              fontWeight: 700,
              color: activeCount > 0 ? "#137333" : "#6b7280",
              background: activeCount > 0 ? "#e7f6ec" : "#f3f4f6",
              verticalAlign: "middle",
            }}
          >
            {activeCount} active
          </span>
        </h3>
        <button
          onClick={() => setShowPairModal(true)}
          style={{ background: "#1d4ed8", color: "white" }}
        >
          {"\uFF0B"} Pair Mobile Device
        </button>
      </div>

      <p
        style={{
          fontSize: "0.83rem",
          color: "var(--color-text-secondary, #64748b)",
          margin: "0.5rem 0 0.75rem 0",
          lineHeight: "1.5",
        }}
      >
        Bind a mobile companion to this vault via an offline QR handshake.
        Paired devices can receive an encrypted seed frame at pairing time and
        sync identity material in future increments.
      </p>

      {error && (
        <p style={{ color: "#dc2626", fontSize: "0.82rem", margin: "0 0 0.5rem 0" }}>
          {error}
        </p>
      )}

      {loading ? (
        <p className="muted" style={{ fontSize: "0.83rem" }}>
          Loading paired devices…
        </p>
      ) : (
        <PairedDeviceList devices={devices} onChanged={refresh} />
      )}

      {showPairModal && (
        <PairQrModal
          open={showPairModal}
          onClose={() => setShowPairModal(false)}
          onPaired={refresh}
        />
      )}
    </div>
  );
}