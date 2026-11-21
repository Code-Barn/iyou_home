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

interface RelayStatusPayload {
  frame_id: string;
  status: "connecting" | "connected" | "offline" | "completed" | "error";
  relay: string;
  message?: string;
}

interface OfflineSealedResponse {
  envelope: {
    frame_id: string;
    device_did: string;
    iv_b64: string;
    ciphertext_b64: string;
  };
  sealed_qr_png_b64: string;
  sealed_uri: string;
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

  // Relay signaling status state
  const [relayStatus, setRelayStatus] = useState<"connecting" | "connected" | "offline" | "completed" | "error">("connecting");
  const [relayMessage, setRelayMessage] = useState<string | null>(null);

  // Offline air-gapped response state
  const [offlineInput, setOfflineInput] = useState("");
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [offlineSealed, setOfflineSealed] = useState<OfflineSealedResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const frameRef = useRef<PairFrame | null>(null);
  const statusRef = useRef<PairStatus>("idle");
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

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
      setOfflineError(null);
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
    setOfflineError(null);
    setOfflineInput("");
    setOfflineSealed(null);
    setRelayStatus("connecting");
    setRelayMessage(null);
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

  // Cancel frame immediately when closed
  const handleModalClose = useCallback(() => {
    if (frameRef.current && statusRef.current === "scanning") {
      void invoke("pair_cancel", { frameId: frameRef.current.frame_id }).catch(() => {});
    }
    onClose();
  }, [onClose]);

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

  // Listen for the backend handshake completion (mobile path).
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
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, enterVerified]);

  // Listen for relay signaling status updates.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    listen<RelayStatusPayload>("pair://relay-status", (event) => {
      if (cancelled) return;
      if (frameRef.current && event.payload.frame_id !== frameRef.current.frame_id) return;
      setRelayStatus(event.payload.status);
      if (event.payload.message) {
        setRelayMessage(event.payload.message);
      }
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
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
      if (frameRef.current && statusRef.current === "scanning") {
        void invoke("pair_cancel", { frameId: frameRef.current.frame_id }).catch(() => {});
      }
    },
    []
  );

  const handleProcessOfflineResponse = async () => {
    if (!offlineInput.trim()) {
      setOfflineError("Please paste the response URI or JSON from iyou_mobile_swift.");
      return;
    }
    setOfflineBusy(true);
    setOfflineError(null);
    try {
      const res = await invoke<OfflineSealedResponse>("pair_process_offline_response", {
        responseUriOrJson: offlineInput.trim(),
      });
      setOfflineSealed(res);
      onPaired();
    } catch (e) {
      setOfflineError(typeof e === "string" ? e : String(e));
    } finally {
      setOfflineBusy(false);
    }
  };

  if (!open) return null;

  const lowTime = status === "scanning" && remaining <= 30;

  return (
    <div className="modal-overlay" onClick={handleModalClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "540px" }}
      >
        <h3 style={{ marginTop: 0 }}>{"\uD83D\uDCF1"} Pair Mobile Device</h3>

        {/* Security warning */}
        <div
          style={{
            border: "1px solid #f59e0b",
            background: "#fffbeb",
            borderRadius: "8px",
            padding: "0.75rem 1rem",
            marginBottom: "0.85rem",
          }}
        >
          <p style={{ margin: 0, fontSize: "0.82rem", color: "#92400e", lineHeight: "1.55" }}>
            <strong>Security note:</strong> scanning this QR initiates an encrypted
            root master seed transfer to your mobile companion. The 6-character code below
            is the physical presence proof — only scan with a device you control.
            Frames expire in 5 minutes and are never persisted unencrypted.
          </p>
        </div>

        {/* Live Relay Status Pill */}
        {status === "scanning" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.4rem 0.75rem",
              borderRadius: "6px",
              fontSize: "0.78rem",
              marginBottom: "1rem",
              background:
                relayStatus === "connected"
                  ? "#f0fdf4"
                  : relayStatus === "offline" || relayStatus === "error"
                  ? "#fffbeb"
                  : "#f8fafc",
              border: `1px solid ${
                relayStatus === "connected"
                  ? "#bbf7d0"
                  : relayStatus === "offline" || relayStatus === "error"
                  ? "#fde68a"
                  : "#e2e8f0"
              }`,
              color:
                relayStatus === "connected"
                  ? "#166534"
                  : relayStatus === "offline" || relayStatus === "error"
                  ? "#92400e"
                  : "#475569",
            }}
          >
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background:
                  relayStatus === "connected"
                    ? "#22c55e"
                    : relayStatus === "offline" || relayStatus === "error"
                    ? "#f59e0b"
                    : "#3b82f6",
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 500 }}>
              {relayMessage ||
                (relayStatus === "connected"
                  ? "Live relay active (relay.iyou.me) — waiting for mobile companion"
                  : relayStatus === "offline" || relayStatus === "error"
                  ? "Relay unreachable — use Complete Offline / Air-Gapped Pairing below"
                  : "Connecting to signaling relay (relay.iyou.me)...")}
            </span>
          </div>
        )}

        {loading && <p className="muted">Generating ephemeral pairing frame…</p>}
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
          <div style={{ textAlign: "center", padding: "1.5rem 0" }}>
            <div style={{ fontSize: "2.8rem" }}>{"\u2705"}</div>
            <h3 style={{ margin: "0.5rem 0 0.25rem 0" }}>
              Paired {verifiedDevice.device_name}
            </h3>
            <p className="muted" style={{ fontSize: "0.82rem" }}>
              The device is now registered in pairing.json and bound to this vault.
            </p>
          </div>
        )}

        {(status === "scanning" || status === "expired") && frame && (
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
                    width={220}
                    height={220}
                    style={{ display: "block", borderRadius: "4px" }}
                  />
                ) : (
                  <div style={{ width: 220, height: 220 }} />
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
                      fontSize: "0.88rem",
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

            {/* Offline / Air-Gapped Pairing Panel */}
            {status === "scanning" && (
              <details
                open={Boolean(offlineSealed)}
                style={{
                  border: "1px dashed var(--color-border, #cbd5e1)",
                  borderRadius: "8px",
                  padding: "0.6rem 0.85rem",
                  marginBottom: "1rem",
                  background: offlineSealed ? "#f8fafc" : "transparent",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: "0.82rem",
                    color: "var(--color-text-secondary, #475569)",
                    fontWeight: 600,
                  }}
                >
                  Complete Offline / Air-Gapped Pairing
                </summary>

                {!offlineSealed ? (
                  <div style={{ marginTop: "0.6rem" }}>
                    <p style={{ fontSize: "0.76rem", color: "var(--color-text-muted, #64748b)", marginTop: 0, lineHeight: "1.45" }}>
                      If your mobile companion is air-gapped or cannot reach relay.iyou.me, paste the response URI or JSON from <strong>iyou_mobile_swift</strong> below.
                    </p>
                    <div className="form-group" style={{ marginBottom: "0.5rem" }}>
                      <textarea
                        rows={3}
                        value={offlineInput}
                        onChange={(e) => setOfflineInput(e.target.value)}
                        placeholder="iyouhome://pair-ack?frame_id=...&x25519=...&did=...&name=...&code=..."
                        style={{
                          width: "100%",
                          fontSize: "0.74rem",
                          fontFamily: "var(--font-mono, monospace)",
                          padding: "0.45rem",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                    {offlineError && (
                      <p style={{ color: "#dc2626", fontSize: "0.78rem", margin: "0 0 0.5rem 0" }}>
                        {offlineError}
                      </p>
                    )}
                    <button
                      onClick={handleProcessOfflineResponse}
                      disabled={offlineBusy}
                      style={{
                        background: "#2563eb",
                        color: "white",
                        padding: "0.45rem 0.85rem",
                        fontSize: "0.8rem",
                        borderRadius: "6px",
                        cursor: "pointer",
                        border: "none",
                        fontWeight: 500,
                      }}
                    >
                      {offlineBusy ? "Sealing Seed…" : "Process Response & Seal Seed"}
                    </button>
                  </div>
                ) : (
                  <div style={{ marginTop: "0.75rem", textAlign: "center" }}>
                    <p style={{ fontSize: "0.84rem", fontWeight: 600, color: "#166534", margin: "0 0 0.4rem 0" }}>
                      {"\u2705"} Seed Envelope Sealed Successfully
                    </p>
                    <p style={{ fontSize: "0.75rem", color: "#64748b", margin: "0 0 0.75rem 0", lineHeight: "1.4" }}>
                      <strong>Step 3:</strong> Scan this sealed seed QR code with <strong>iyou_mobile_swift</strong> to finalize master seed import.
                    </p>
                    <div
                      style={{
                        display: "inline-block",
                        padding: "8px",
                        background: "#fff",
                        border: "1px solid #e5e7eb",
                        borderRadius: "8px",
                        marginBottom: "0.75rem",
                      }}
                    >
                      <img
                        src={offlineSealed.sealed_qr_png_b64}
                        alt="Sealed seed QR code"
                        width={220}
                        height={220}
                        style={{ display: "block" }}
                      />
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center", alignItems: "center", flexWrap: "wrap" }}>
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(offlineSealed.sealed_uri);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                        style={{
                          fontSize: "0.76rem",
                          padding: "0.35rem 0.65rem",
                          background: "#f1f5f9",
                          border: "1px solid #cbd5e1",
                          borderRadius: "6px",
                          cursor: "pointer",
                        }}
                      >
                        {copied ? "\u2705 Copied URI" : "\uD83D\uDCCB Copy Sealed URI"}
                      </button>
                      <button
                        onClick={() => {
                          enterVerified({
                            device_id: offlineSealed.envelope.frame_id,
                            device_did: offlineSealed.envelope.device_did,
                            device_name: "Paired Companion",
                            paired_at: Math.floor(Date.now() / 1000),
                            last_seen_at: Math.floor(Date.now() / 1000),
                            revoked_at: null,
                          });
                        }}
                        style={{
                          fontSize: "0.76rem",
                          padding: "0.35rem 0.75rem",
                          background: "#16a34a",
                          color: "#fff",
                          border: "none",
                          borderRadius: "6px",
                          cursor: "pointer",
                          fontWeight: 600,
                        }}
                      >
                        Finish Pairing
                      </button>
                    </div>
                  </div>
                )}
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
            onClick={handleModalClose}
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
