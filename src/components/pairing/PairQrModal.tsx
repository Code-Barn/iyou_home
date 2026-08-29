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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { PairedDeviceRecord } from "./PairedDeviceList";

interface PairFrame {
  frame_id: string;
  verification_code: string;
  qr_png_b64: string;
  expires_at: number;
}

type PairStatus = "idle" | "scanning" | "verified" | "expired";

interface Props {
  open: boolean;
  onClose: () => void;
  onPaired: () => void;
}

function secondsLeft(expiresAt: number): number {
  return expiresAt - Math.floor(Date.now() / 1000);
}

export default function PairQrModal({ open, onClose, onPaired }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<PairFrame | null>(null);
  const [status, setStatus] = useState<PairStatus>("idle");
  const [remaining, setRemaining] = useState(0);
  const [verifiedDevice, setVerifiedDevice] = useState<PairedDeviceRecord | null>(null);

  // Manual handshake harness state.
  const [deviceDid, setDeviceDid] = useState("did:key:smashphone-proto");
  const [deviceName, setDeviceName] = useState("Smashphone (proto)");
  const [codeInput, setCodeInput] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const statusRef = useRef<PairStatus>("idle");
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const enterVerified = useCallback(
    (record: PairedDeviceRecord) => {
      if (statusRef.current === "verified") return;
      statusRef.current = "verified";
      setStatus("verified");
      setVerifiedDevice(record);
      setError(null);
      setManualError(null);
      onPaired();
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => onClose(), 1600);
    },
    [onPaired, onClose]
  );

  const startPairing = useCallback(async () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setLoading(true);
    setError(null);
    setManualError(null);
    setCodeInput("");
    try {
      const f = await invoke<PairFrame>("pair_begin");
      setFrame(f);
      setStatus("scanning");
      setRemaining(secondsLeft(f.expires_at));
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Begin a fresh frame whenever the modal opens.
  useEffect(() => {
    if (open) void startPairing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Countdown while the frame is live.
  useEffect(() => {
    if (!open || !frame || status !== "scanning") return;
    const id = window.setInterval(() => {
      const rem = secondsLeft(frame.expires_at);
      setRemaining(rem);
      if (rem <= 0) setStatus("expired");
    }, 1000);
    return () => window.clearInterval(id);
  }, [open, frame, status]);

  // Listen for the backend handshake completion (real mobile path).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<PairedDeviceRecord>("pair://status", (event) => {
      if (!cancelled) enterVerified(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* event bus unavailable — manual harness still works */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, enterVerified]);

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    []
  );

  const handleSimulateConfirm = async () => {
    if (!frame) return;
    setManualError(null);
    setError(null);
    if (codeInput.trim() !== frame.verification_code) {
      setManualError("Verification code does not match the displayed code.");
      return;
    }
    if (!deviceDid.trim()) {
      setManualError("Device DID is required.");
      return;
    }
    if (!deviceName.trim()) {
      setManualError("Device name is required.");
      return;
    }
    setBusy(true);
    try {
      const record = await invoke<PairedDeviceRecord>("pair_confirm", {
        frameId: frame.frame_id,
        deviceDid: deviceDid.trim(),
        deviceName: deviceName.trim(),
      });
      enterVerified(record);
    } catch (e) {
      setManualError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const lowTime = status === "scanning" && remaining <= 30;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "520px" }}
      >
        <h3 style={{ marginTop: 0 }}>{"\uD83D\uDCF1"} Pair Mobile Device</h3>

        {/* High-friction security warning */}
        <div
          style={{
            border: "1px solid #f59e0b",
            background: "#fffbeb",
            borderRadius: "8px",
            padding: "0.75rem 1rem",
            marginBottom: "1rem",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.82rem", color: "#92400e", lineHeight: "1.55" }}>
            <strong>Security note:</strong> scanning this QR begins an encrypted
            seed handshake to a <em>new</em> device. The 6-character code below
            is the authorization proof — anyone holding the QR and code could
            initiate a sealed seed frame to their own device. Only scan with a
            device you control. The frame expires automatically in 5 minutes
            and is never persisted.
          </p>
        </div>

        {loading && <p className="muted">Generating offline pairing frame…</p>}
        {error && (
          <p
            style={{
              color: "#dc2626",
              fontSize: "0.82rem",
              background: "#fef2f2",
              padding: "0.5rem 0.75rem",
              borderRadius: "6px",
            }}
          >
            {error}
          </p>
        )}

        {status === "verified" && verifiedDevice && (
          <div style={{ textAlign: "center", padding: "1rem 0" }}>
            <div style={{ fontSize: "2.5rem" }}>{"\u2705"}</div>
            <h3 style={{ margin: "0.25rem 0" }}>
              Paired {verifiedDevice.device_name}
            </h3>
            <p className="muted" style={{ fontSize: "0.82rem" }}>
              The device is now bound to this vault and appears in the paired
              device list.
            </p>
          </div>
        )}

        {((status === "scanning" || status === "expired") && frame) && (
          <>
            <div
              style={{
                display: "flex",
                gap: "1rem",
                alignItems: "center",
                marginBottom: "1rem",
              }}
            >
              <div
                style={{
                  border: "1px solid var(--color-border, #e5e7eb)",
                  borderRadius: "10px",
                  padding: "8px",
                  background: "#fff",
                  flexShrink: 0,
                }}
              >
                {frame.qr_png_b64 ? (
                  <img
                    src={frame.qr_png_b64}
                    alt="Pairing QR code"
                    width={240}
                    height={240}
                    style={{ display: "block", borderRadius: "4px" }}
                  />
                ) : (
                  <div style={{ width: 240, height: 240 }} />
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontSize: "0.72rem",
                    color: "var(--color-text-muted)",
                    margin: "0 0 0.25rem 0",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    fontWeight: 600,
                  }}
                >
                  Verification code
                </p>
                <p
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "1.9rem",
                    fontWeight: 700,
                    letterSpacing: "0.35em",
                    margin: "0 0 0.75rem 0",
                    color: "#b45309",
                  }}
                >
                  {frame.verification_code}
                </p>
                <p
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "0.72rem",
                    color: "var(--color-text-muted)",
                    margin: "0 0 0.5rem 0",
                    wordBreak: "break-all",
                  }}
                >
                  {frame.frame_id}
                </p>
                {status === "expired" ? (
                  <p style={{ color: "#dc2626", fontSize: "0.85rem", margin: "0" }}>
                    {"\u23F0"} Frame expired — refresh to generate a new code.
                  </p>
                ) : (
                  <p
                    style={{
                      color: lowTime ? "#dc2626" : "#137333",
                      fontWeight: 600,
                      fontSize: "0.9rem",
                      margin: 0,
                    }}
                  >
                    {"\u23F0"} Expires in {Math.max(remaining, 0)}s
                  </p>
                )}
              </div>
            </div>

            {status === "expired" && (
              <button onClick={startPairing} style={{ marginBottom: "1rem" }}>
                {"\uD83D\uDD04"} Refresh Code
              </button>
            )}

            {status === "scanning" && (
              <details
                style={{
                  border: "1px dashed var(--color-border, #cbd5e1)",
                  borderRadius: "8px",
                  padding: "0.5rem 0.75rem",
                  marginBottom: "1rem",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: "0.78rem",
                    color: "var(--color-text-muted)",
                    fontWeight: 600,
                  }}
                >
                  Simulate mobile handshake (no mobile app yet)
                </summary>
                <div style={{ marginTop: "0.5rem" }}>
                  <p style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", marginTop: 0 }}>
                    Type the displayed verification code and a DID to exercise
                    the full confirm path end-to-end on this machine.
                  </p>
                  <div className="form-group">
                    <label>Verification code (must match)</label>
                    <input
                      type="text"
                      value={codeInput}
                      onChange={(e) => setCodeInput(e.target.value)}
                      placeholder={frame.verification_code}
                      maxLength={6}
                      autoComplete="off"
                    />
                  </div>
                  <div className="form-group">
                    <label>Device DID</label>
                    <input
                      type="text"
                      value={deviceDid}
                      onChange={(e) => setDeviceDid(e.target.value)}
                      placeholder="did:key:..."
                    />
                  </div>
                  <div className="form-group">
                    <label>Device name</label>
                    <input
                      type="text"
                      value={deviceName}
                      onChange={(e) => setDeviceName(e.target.value)}
                      placeholder="My phone"
                    />
                  </div>
                  {manualError && (
                    <p style={{ color: "#dc2626", fontSize: "0.8rem", margin: "0 0 0.5rem 0" }}>
                      {manualError}
                    </p>
                  )}
                  <button
                    onClick={handleSimulateConfirm}
                    disabled={busy}
                    style={{ background: "#137333", color: "white" }}
                  >
                    {busy ? "Confirming…" : "Complete Pairing"}
                  </button>
                </div>
              </details>
            )}
          </>
        )}

        <div style={{ marginTop: "1rem", textAlign: "right", display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
          {status === "scanning" && (
            <button
              onClick={startPairing}
              style={{
                background: "#f3f4f6",
                border: "1px solid #d1d5db",
                color: "var(--color-text-secondary)",
              }}
            >
              {"\uD83D\uDD04"} New Code
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              background: "#f3f4f6",
              border: "1px solid #d1d5db",
              color: "var(--color-text-secondary)",
            }}
          >
            {status === "verified" ? "Finished" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}