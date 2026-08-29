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

import type { CSSProperties } from "react";
import type { OmemoDeviceInfo } from "../../../lib/omemoSession";

interface OmemoTrustModalProps {
  open: boolean;
  peerName: string;
  peerDevice: OmemoDeviceInfo | null;
  localDevice: OmemoDeviceInfo | null;
  trustState: "untrusted" | "verified";
  fingerprintOf: (device: OmemoDeviceInfo | null) => string;
  onVerify: (deviceId: number) => void;
  onClose: () => void;
}

export default function OmemoTrustModal({
  open,
  peerName,
  peerDevice,
  localDevice,
  trustState,
  fingerprintOf,
  onVerify,
  onClose,
}: OmemoTrustModalProps) {
  if (!open) {
    return null;
  }

  const overlayStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 60,
  };

  const cardStyle: CSSProperties = {
    background: "white",
    borderRadius: "12px",
    padding: "1.25rem",
    width: "min(92vw, 26rem)",
    boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
  };

  const row = (label: string, value: string) => (
    <div style={{ marginBottom: "0.75rem" }}>
      <div
        style={{
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          color: "#6b7280",
          marginBottom: "0.2rem",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "monospace",
          fontSize: "0.8rem",
          color: "#334155",
          wordBreak: "break-all",
          background: "#f1f5f9",
          padding: "0.4rem 0.5rem",
          borderRadius: "6px",
        }}
      >
        {value}
      </div>
    </div>
  );

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <h4 style={{ margin: "0 0 0.25rem" }}>
          🔐 OMEMO Identity Trust — {peerName}
        </h4>
        <p style={{ margin: "0 0 1rem", fontSize: "0.8rem", color: "#64748b" }}>
          Verify the peer device fingerprint out-of-band before marking this
          session as trusted.
        </p>

        {row("Your enclave device (session)", fingerprintOf(localDevice))}
        {localDevice && (
          <div style={{ fontSize: "0.72rem", color: "#94a3b8", marginBottom: "0.75rem" }}>
            device id {localDevice.device_id}
          </div>
        )}

        {peerDevice ? (
          <>
            {row(
              `${peerName}'s device fingerprint`,
              fingerprintOf(peerDevice),
            )}
            <div style={{ fontSize: "0.72rem", color: "#94a3b8" }}>
              device id {peerDevice.device_id}
            </div>
            <p
              style={{
                fontSize: "0.78rem",
                margin: "0.9rem 0",
                padding: "0.5rem 0.6rem",
                borderRadius: "6px",
                background: trustState === "verified" ? "#e7f6ec" : "#fff7ed",
                color: trustState === "verified" ? "#137333" : "#9a3412",
              }}
            >
              {trustState === "verified"
                ? "This device is verified. Sealed messages are expected."
                : "Untrusted — you have not confirmed this peer's device key."}
            </p>
          </>
        ) : (
          <p style={{ fontSize: "0.8rem", color: "#b45309" }}>
            No published OMEMO device found for this peer yet. They must publish
            their bundle on this enclave first.
          </p>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "0.5rem",
            marginTop: "1rem",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "0.4rem 0.9rem",
              background: "#f3f4f6",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              fontSize: "0.82rem",
            }}
          >
            Close
          </button>
          {peerDevice && (
            <button
              type="button"
              onClick={() => onVerify(peerDevice.device_id)}
              style={{
                padding: "0.4rem 0.9rem",
                background: "#16a34a",
                color: "white",
                border: "none",
                borderRadius: "6px",
                fontSize: "0.82rem",
              }}
            >
              Verify device
            </button>
          )}
        </div>
      </div>
    </div>
  );
}