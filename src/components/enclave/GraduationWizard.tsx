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

import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getOrRegisterPrfSeed, webauthnPrfSupported } from "../../lib/webauthnPrf";

interface GraduationWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
}

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

interface TransitKeypairPublic {
  client_ephemeral_pub_hex: string;
}

interface GraduationExportResponse {
  server_ephemeral_pub: string;
  nonce: string;
  ciphertext: string;
  custodial_did?: string;
}

interface GraduationConfirmPayload {
  receipt: { action: string; did: string; issued_at: number };
  signature: string;
}

const DEFAULT_IDP_URL = "https://iyou.me";
const CSRF_COOKIE_NAME = "csrftoken";

const STEP_LABELS: Record<WizardStep, string> = {
  1: "Initiation",
  2: "Biometric Challenge",
  3: "Key Handshake",
  4: "Local Decryption & Ingest",
  5: "Confirmation & Shred",
  6: "Sovereign Custody Claimed",
};

function readCsrfToken(): string | null {
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

async function postToIdp<T>(
  idpUrl: string,
  path: string,
  body: unknown,
): Promise<T> {
  const csrfToken = readCsrfToken();
  if (!csrfToken) {
    throw new Error(
      "No CSRF token found in cookies. Please sign in to your iyou_idp account in this environment first.",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${idpUrl}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRFToken": csrfToken,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Network request to ${idpUrl}${path} failed: ${
        err instanceof Error ? err.message : String(err)
      }. Check the IdP URL and your connection.`,
    );
  }

  const raw = await response.text();
  let payload: unknown = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errObj = (payload ?? {}) as { error?: string; error_description?: string; detail?: string };
    throw new Error(
      `IdP returned ${response.status} from ${path}: ${
        errObj.error_description ||
        errObj.error ||
        errObj.detail ||
        raw.slice(0, 200)
      }`,
    );
  }

  return payload as T;
}

export default function GraduationWizard({
  isOpen,
  onClose,
  onRefresh,
}: GraduationWizardProps) {
  const [step, setStep] = useState<WizardStep>(1);
  const [idpUrl, setIdpUrl] = useState(DEFAULT_IDP_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [sovereignDid, setSovereignDid] = useState<string | null>(null);

  // Secrets live in refs only — never in renderable React state (Zero UI Leakage).
  const prfKekHexRef = useRef<string | null>(null);
  const exportResponseRef = useRef<GraduationExportResponse | null>(null);
  const confirmPayloadRef = useRef<GraduationConfirmPayload | null>(null);

  if (!isOpen) return null;

  const normalizedIdpUrl = () => idpUrl.trim().replace(/\/+$/, "");

  const reset = () => {
    setStep(1);
    setError(null);
    setStatusLine(null);
    setSovereignDid(null);
    prfKekHexRef.current = null;
    exportResponseRef.current = null;
    confirmPayloadRef.current = null;
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const runGraduation = async (fromStep: WizardStep) => {
    setBusy(true);
    setError(null);

    try {
      let custodialDid: string;

      if (fromStep <= 2) {
        if (!webauthnPrfSupported()) {
          throw new Error(
            "WebAuthn PRF is not available here. Use Safari 18+, Chrome 128+, or Edge 128+ with Touch ID / Windows Hello enabled.",
          );
        }
        setStep(2);
        setStatusLine("Awaiting platform authenticator (Touch ID / Windows Hello / Passkey)…");
        const prf = await getOrRegisterPrfSeed();
        prfKekHexRef.current = prf.prfSeedHex;
        setStatusLine(
          prf.registered
            ? "New PRF passkey registered and biometric seed derived."
            : "Biometric PRF seed derived.",
        );
      }

      if (fromStep <= 3) {
        setStep(3);
        setStatusLine("Generating ephemeral X25519 transit keypair…");
        const transit = await invoke<TransitKeypairPublic>("generate_transit_keypair");

        setStatusLine("Requesting sealed identity export from IdP…");
        const exported = await postToIdp<GraduationExportResponse>(
          normalizedIdpUrl(),
          "/api/v1/identity/graduate/export/",
          { ephemeral_pubkey: transit.client_ephemeral_pub_hex },
        );

        if (
          !exported.server_ephemeral_pub ||
          !exported.nonce ||
          !exported.ciphertext
        ) {
          throw new Error(
            "IdP export response is incomplete: expected server_ephemeral_pub, nonce and ciphertext.",
          );
        }
        custodialDid =
          exported.custodial_did ??
          (() => {
            throw new Error(
              "IdP export response did not include custodial_did; cannot bind the graduation receipt.",
            );
          })();
        exportResponseRef.current = exported;
        setStatusLine("Sealed export received.");
      } else {
        const exported = exportResponseRef.current;
        custodialDid =
          exported?.custodial_did ??
          (() => {
            throw new Error("Graduation session expired — please restart the wizard.");
          })();
      }

      if (fromStep <= 4) {
        setStep(4);
        setStatusLine("Unsealing custodial seed and ingesting into local vault…");
        if (!prfKekHexRef.current || !exportResponseRef.current) {
          throw new Error("Graduation session expired — please restart the wizard.");
        }
        confirmPayloadRef.current = await invoke<GraduationConfirmPayload>(
          "process_graduation_ingest",
          {
            serverEphemeralPubHex: exportResponseRef.current.server_ephemeral_pub,
            nonceHex: exportResponseRef.current.nonce,
            ciphertextHex: exportResponseRef.current.ciphertext,
            custodialDid,
            prfKekHex: prfKekHexRef.current,
          },
        );
        setStatusLine("Sovereign persona sealed into local vault.");
      }

      if (fromStep <= 5) {
        setStep(5);
        setStatusLine("Submitting signed graduation receipt…");
        if (!confirmPayloadRef.current) {
          throw new Error("Graduation session expired — please restart the wizard.");
        }
        await postToIdp<{ status?: string }>(
          normalizedIdpUrl(),
          "/api/v1/identity/graduate/confirm/",
          {
            receipt: confirmPayloadRef.current.receipt,
            signature: confirmPayloadRef.current.signature,
          },
        );

        await invoke("activate_sovereign_identity", { did: custodialDid });
        setSovereignDid(custodialDid);
        // Drop all sensitive intermediates immediately.
        prfKekHexRef.current = null;
        exportResponseRef.current = null;
      }

      setStep(6);
      setStatusLine(null);
      await onRefresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatusLine(null);
    } finally {
      setBusy(false);
    }
  };

  const completedThrough = (marker: WizardStep) =>
    step > marker || (step === 6 && marker >= 2 && marker <= 5);

  return (
    <div className="modal-overlay">
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "640px", width: "95%" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
            borderBottom: "1px solid #e5e7eb",
            paddingBottom: "0.75rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.4rem" }}>👑</span>
            <h3 style={{ margin: 0 }}>Claim Sovereign Custody</h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              fontSize: "1.2rem",
              cursor: busy ? "not-allowed" : "pointer",
              padding: "0.2rem 0.5rem",
            }}
          >
            ✕
          </button>
        </div>

        {/* Stepper */}
        <ol
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.35rem 0.75rem",
            listStyle: "none",
            padding: 0,
            margin: "0 0 1.25rem",
            fontSize: "0.72rem",
          }}
        >
          {(Object.keys(STEP_LABELS) as unknown as number[]).map((n) => {
            const num = n as WizardStep;
            const isActive = step === num && step !== 6;
            const isDone = completedThrough(num);
            return (
              <li
                key={num}
                style={{
                  padding: "0.25rem 0.6rem",
                  borderRadius: "12px",
                  fontWeight: 600,
                  background: isActive ? "#4338ca" : isDone ? "#065f46" : "#f3f4f6",
                  color: isActive || isDone ? "white" : "#6b7280",
                }}
              >
                {isDone ? "✓" : num}. {STEP_LABELS[num]}
              </li>
            );
          })}
        </ol>

        {error && <div className="error-message">{error}</div>}
        {busy && statusLine && (
          <div
            style={{
              background: "#eef2ff",
              color: "#3730a3",
              padding: "0.6rem 0.85rem",
              borderRadius: "6px",
              marginBottom: "1rem",
              border: "1px solid #c7d2fe",
              fontSize: "0.85rem",
            }}
          >
            ⏳ {statusLine}
          </div>
        )}

        {/* STEP 1: Initiation */}
        {step === 1 && (
          <div>
            <p style={{ fontSize: "0.9rem", color: "#4b5563", marginTop: 0 }}>
              Graduate your managed IdP identity into full sovereign custody.
              The custodial Ed25519 seed will be exported over an ephemeral
              ECDH channel, re-sealed behind your biometric PRF key inside this
              enclave, signed for confirmation, and shredded server-side.
            </p>
            <div
              style={{
                background: "#fff7ed",
                border: "1px solid #fed7aa",
                color: "#9a3412",
                borderRadius: "6px",
                padding: "0.7rem 0.9rem",
                fontSize: "0.82rem",
                marginBottom: "1rem",
              }}
            >
              ⚠️ This is irreversible. After graduation, the IdP permanently
              deletes its copy of your key and can no longer mint sessions for
              this DID — you must authenticate directly with your own vault.
            </div>

            <div className="form-group">
              <label>Identity Provider Base URL</label>
              <input
                type="url"
                value={idpUrl}
                onChange={(e) => setIdpUrl(e.target.value)}
                placeholder={DEFAULT_IDP_URL}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem" }}>
              <button
                type="button"
                onClick={() => runGraduation(2)}
                disabled={busy || !idpUrl.trim()}
                style={{
                  padding: "0.6rem 1.25rem",
                  background: "#4338ca",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                Start Graduation →
              </button>
            </div>
          </div>
        )}

        {/* STEPS 2–5: inline progress states */}
        {[2, 3, 4, 5].includes(step) && (
          <div>
            <div
              style={{
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
                padding: "1rem",
                marginBottom: "1rem",
              }}
            >
              <strong style={{ fontSize: "0.95rem" }}>
                {STEP_LABELS[step]}
              </strong>
              <p style={{ margin: "0.5rem 0 0", fontSize: "0.85rem", color: "#4b5563" }}>
                {step === 2 &&
                  "Your platform authenticator is being challenged to derive the local PRF key encryption key. The raw seed stays inside the secure enclave pipeline."}
                {step === 3 &&
                  "Exchanging an ephemeral X25519 handshake key with your IdP so the custodial seed can be transferred sealed — never in plaintext over the wire."}
                {step === 4 &&
                  "Decrypting the sealed export locally via ECDH → HKDF → AES-256-GCM, then sealing it into vault.json under your biometric PRF key."}
                {step === 5 &&
                  "Signing the canonical graduation receipt with your imported sovereign key and submitting it. On acceptance the IdP shreds its Vault copy."}
              </p>
            </div>

            {!busy && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <button
                  type="button"
                  onClick={reset}
                  style={{
                    padding: "0.5rem 1rem",
                    background: "#f3f4f6",
                    color: "#374151",
                    border: "1px solid #d1d5db",
                    borderRadius: "6px",
                  }}
                >
                  ← Restart
                </button>
                <button
                  type="button"
                  onClick={() => runGraduation(step)}
                  style={{
                    padding: "0.55rem 1.25rem",
                    background: "#4338ca",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontWeight: 600,
                  }}
                >
                  Retry Step {step} →
                </button>
              </div>
            )}
          </div>
        )}

        {/* STEP 6: Completion */}
        {step === 6 && sovereignDid && (
          <div style={{ textAlign: "center", padding: "0.5rem 0" }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.45rem",
                background: "linear-gradient(135deg, #065f46 0%, #059669 100%)",
                color: "white",
                padding: "0.4rem 1rem",
                borderRadius: "20px",
                fontWeight: 700,
                fontSize: "0.85rem",
                marginBottom: "1rem",
              }}
            >
              🛡️ Sovereign Custody Verified
            </div>
            <h4 style={{ margin: "0 0 0.5rem", fontSize: "1.15rem" }}>
              You are now fully self-custodied
            </h4>
            <div
              style={{
                fontFamily: "monospace",
                fontSize: "0.8rem",
                wordBreak: "break-all",
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
                padding: "0.75rem",
                marginBottom: "1.25rem",
              }}
            >
              {sovereignDid}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "0.6rem",
                textAlign: "left",
                marginBottom: "1.25rem",
              }}
            >
              {[
                ["✓", "Biometric PRF KEK", "Derived via WebAuthn passkey"],
                ["✓", "Sealed Transit", "X25519 ECDH + AES-256-GCM export"],
                ["✓", "Local Vault Ingest", "ChaCha20-Poly1305 under PRF key"],
                ["✓", "IdP Shred Confirmed", "Receipt signed & accepted"],
              ].map(([icon, title, sub]) => (
                <div
                  key={title}
                  style={{
                    background: "#e6f4ea",
                    border: "1px solid #ceead6",
                    borderRadius: "8px",
                    padding: "0.65rem 0.8rem",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "#137333" }}>
                    {icon} {title}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#1e7145" }}>{sub}</div>
                </div>
              ))}
            </div>

            <p style={{ fontSize: "0.82rem", color: "#6b7280", margin: "0 0 1rem" }}>
              Your active signer has switched to this sovereign DID. The IdP can
              no longer mint OIDC sessions for it.
            </p>

            <button
              type="button"
              onClick={handleClose}
              style={{
                padding: "0.6rem 1.5rem",
                background: "#065f46",
                color: "white",
                border: "none",
                borderRadius: "6px",
                fontWeight: 600,
              }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
