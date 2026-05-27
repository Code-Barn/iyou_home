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

import { useState, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";

interface Profile {
  profile_id: string;
  profile_name: string;
  derivation_index: number;
  did: string;
}

type SignRequest =
  | { type: "sign"; challenge: string; profile_id?: string }
  | { type: "sign_event"; event: any; profile_id?: string }
  | {
      type: "sign_credential";
      credential: any;
      holder_did: string;
      profile_id?: string;
    }
  | {
      type: "POLLY_CREDENTIAL_REQUEST";
      required_credential_type: string;
      challenge: string;
      profile_id?: string;
    };

function getCredentialTitle(credential: any): string {
  const rawTypes = credential?.type;
  let types: string[] = [];
  if (Array.isArray(rawTypes)) {
    types = rawTypes;
  } else if (typeof rawTypes === "string") {
    types = [rawTypes];
  } else {
    return "Credential";
  }
  const specific = types.filter((t) => t !== "VerifiableCredential");
  if (specific.length === 0) return "Credential";
  const name = specific[0]
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return name;
}

export default function WsSignPopup() {
  const [request, setRequest] = useState<SignRequest | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autoSign, setAutoSign] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>("primary");

  useEffect(() => {
    const channel = new Channel<string>();
    channel.onmessage = (data) => {
      console.log("REACT: Received message via direct channel pipe:", data);
      try {
        const parsed = JSON.parse(data);
        const profile_id = parsed.profile_id || undefined;
        if (parsed.__type__ === "sign_event") {
          setRequest({ type: "sign_event", event: parsed.event, profile_id });
        } else if (parsed.__type__ === "sign_credential") {
          setRequest({
            type: "sign_credential",
            credential: parsed.credential,
            holder_did: parsed.holder_did,
            profile_id,
          });
        } else if (parsed.__type__ === "POLLY_CREDENTIAL_REQUEST") {
          setRequest({
            type: "POLLY_CREDENTIAL_REQUEST",
            required_credential_type: parsed.required_credential_type,
            challenge: parsed.challenge,
            profile_id,
          });
        } else if (parsed.__type__ === "sign") {
          setRequest({ type: "sign", challenge: parsed.challenge, profile_id });
        } else {
          setRequest({ type: "sign", challenge: data, profile_id });
        }
      } catch {
        setRequest({ type: "sign", challenge: data });
      }
    };
    invoke("register_challenge_pipe", { channel });
    console.log("REACT: Challenge channel registered with backend");

    // Load profiles and active profile
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      const [profilesList, activeDid] = await Promise.all([
        invoke<Profile[]>("list_profiles"),
        invoke<string | null>("get_active_did"),
      ]);

      setProfiles(profilesList);

      // Find the active profile
      if (activeDid) {
        const activeProfile = profilesList.find((p) => p.did === activeDid);
        if (activeProfile) {
          setActiveProfileId(activeProfile.profile_id);
        }
      }
    } catch (err) {
      console.error("Failed to load profiles:", err);
    }
  };

  useEffect(() => {
    if (autoSign && request && !isProcessing) {
      console.log("REACT: Auto-sign enabled, approving immediately");
      handleResponse(true);
    }
  }, [autoSign, request]);

  const handleResponse = async (approved: boolean) => {
    if (!request) return;
    setIsProcessing(true);

    try {
      if (request.type === "sign_event") {
        await invoke("submit_ws_event_response", {
          eventJson: JSON.stringify(request.event),
          approved,
          profileId: request.profile_id || null,
        });
        console.log("REACT: submit_ws_event_response succeeded");
      } else if (request.type === "sign_credential") {
        await invoke("submit_ws_credential_response", {
          credentialJson: JSON.stringify(request.credential),
          holderDid: request.holder_did,
          approved,
          profileId: request.profile_id || null,
        });
        console.log("REACT: submit_ws_credential_response succeeded");
      } else if (request.type === "POLLY_CREDENTIAL_REQUEST") {
        await invoke("submit_ws_credential_presentation", {
          credentialType: request.required_credential_type,
          challenge: request.challenge,
          approved,
          profileId: request.profile_id || null,
        });
        console.log("REACT: submit_ws_credential_presentation succeeded");
      } else {
        await invoke("submit_ws_response", {
          id: "",
          challenge: request.challenge,
          approved,
          profileId: request.profile_id || null,
        });
        console.log("REACT: submit_ws_response succeeded");
      }
    } catch (err) {
      console.error("Failed to submit WS response:", err);
    } finally {
      setIsProcessing(false);
      setRequest(null);
    }
  };

  if (!request) return null;

  return (
    <div
      className="popup-overlay"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        className="popup-content"
        style={{
          background: "white",
          padding: "2rem",
          borderRadius: "12px",
          maxWidth: "500px",
          width: "100%",
          boxShadow: "0 10px 25px rgba(0,0,0,0.2)",
        }}
      >
        <h2 style={{ marginTop: 0 }}>
          {request.type === "sign_event"
            ? "Nostr Event Signing Request"
            : request.type === "sign_credential"
              ? `${getCredentialTitle(request.credential)} Signing Request`
              : request.type === "POLLY_CREDENTIAL_REQUEST"
                ? "Credential Sharing Request"
                : "Signature Request"}
        </h2>

        {/* Persona Context Display */}
        {profiles.length > 0 && (
          <div
            style={{
              background: "#e3f2fd",
              padding: "0.75rem 1rem",
              borderRadius: "6px",
              margin: "1rem 0",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <span>👤</span>
            <strong>Signing as:</strong>
            <span>
              {profiles.find(
                (p) => p.profile_id === (request.profile_id || activeProfileId),
              )?.profile_name || "Unknown Profile"}
              {request.profile_id && ` (Profile ID: ${request.profile_id})`}
            </span>
          </div>
        )}

        {request.type === "sign" && (
          <>
            <p>
              A local application is requesting a signature from your Vault
              identity.
            </p>
            <div style={{ margin: "1.5rem 0" }}>
              <strong>Challenge:</strong>
              <pre
                style={{
                  background: "#f4f4f4",
                  padding: "1rem",
                  borderRadius: "6px",
                  overflowX: "auto",
                  fontSize: "0.85em",
                  color: "#333",
                }}
              >
                {request.challenge}
              </pre>
            </div>
          </>
        )}

        {request.type === "sign_event" && (
          <>
            <p>
              A local application is requesting to sign a Nostr event with your
              Vault identity.
            </p>
            <div style={{ margin: "1.5rem 0" }}>
              <strong>Event Details:</strong>
              <pre
                style={{
                  background: "#f4f4f4",
                  padding: "1rem",
                  borderRadius: "6px",
                  overflowX: "auto",
                  fontSize: "0.85em",
                  color: "#333",
                  maxHeight: "250px",
                  overflowY: "auto",
                }}
              >
                {JSON.stringify(request.event, null, 2)}
              </pre>
            </div>
          </>
        )}

        {request.type === "sign_credential" && (
          <>
            <p>
              A local application is requesting to issue a Verifiable Credential
              with your Vault identity as issuer.
            </p>
            <div style={{ margin: "1.5rem 0" }}>
              <strong>Issuer DID:</strong>
              <span
                style={{
                  fontFamily: "monospace",
                  fontSize: "0.85em",
                  display: "block",
                  marginTop: "0.3rem",
                }}
              >
                {request.holder_did}
              </span>
            </div>
            <div style={{ margin: "1rem 0" }}>
              <strong>Credential Body:</strong>
              <pre
                style={{
                  background: "#f4f4f4",
                  padding: "1rem",
                  borderRadius: "6px",
                  overflowX: "auto",
                  fontSize: "0.85em",
                  color: "#333",
                  maxHeight: "250px",
                  overflowY: "auto",
                }}
              >
                {JSON.stringify(request.credential, null, 2)}
              </pre>
            </div>
          </>
        )}

        {request.type === "POLLY_CREDENTIAL_REQUEST" && (
          <>
            <p>
              A local application is requesting proof of{" "}
              <strong>{request.required_credential_type}</strong> from your
              vault.
            </p>
            <div
              style={{
                background: "#fff3e0",
                padding: "0.75rem 1rem",
                borderRadius: "6px",
                margin: "1rem 0",
              }}
            >
              <strong>Requested Credential Type:</strong>
              <span
                style={{
                  display: "block",
                  fontFamily: "monospace",
                  fontSize: "1.1em",
                  marginTop: "0.3rem",
                }}
              >
                {request.required_credential_type}
              </span>
            </div>
            <div style={{ margin: "1rem 0" }}>
              <strong>Challenge (anti-replay):</strong>
              <pre
                style={{
                  background: "#f4f4f4",
                  padding: "0.5rem",
                  borderRadius: "4px",
                  fontSize: "0.8em",
                  color: "#555",
                  overflowX: "auto",
                }}
              >
                {request.challenge}
              </pre>
            </div>
          </>
        )}

        <div
          style={{
            display: "flex",
            gap: "1rem",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <label
            style={{
              fontSize: "0.8rem",
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            <input
              type="checkbox"
              checked={autoSign}
              onChange={(e) => setAutoSign(e.target.checked)}
            />
            Auto-sign (dev)
          </label>
          <div style={{ display: "flex", gap: "1rem" }}>
            <button
              onClick={() => handleResponse(false)}
              disabled={isProcessing}
              style={{
                background: "#f4f4f4",
                color: "#333",
                border: "1px solid #ccc",
              }}
            >
              Deny
            </button>
            <button
              onClick={() => handleResponse(true)}
              disabled={isProcessing}
              style={{ background: "#137333", color: "white" }}
            >
              {isProcessing
                ? "Signing..."
                : request.type === "POLLY_CREDENTIAL_REQUEST"
                  ? "Share Asset"
                  : "Approve & Sign"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
