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

import { useState, useEffect, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { Profile } from "../lib/types";
import { isAnchor } from "../lib/enclaveFilters";

export type SignRequest =
  | { type: "sign"; challenge: string; profile_id?: string; wasQueued?: boolean }
  | { type: "sign_event"; event: any; profile_id?: string; wasQueued?: boolean }
  | {
      type: "sign_credential";
      credential: any;
      holder_did: string;
      profile_id?: string;
      wasQueued?: boolean;
    }
  | {
      type: "POLY_CREDENTIAL_REQUEST";
      required_credential_type: string;
      challenge: string;
      profile_id?: string;
      wasQueued?: boolean;
    };

export function isEligibleForGraceAutoSign(
  req: SignRequest | null,
  profile?: Profile | null,
): boolean {
  if (!req) return false;
  // Requests stashed while the app was locked must never be auto-signed
  if (req.wasQueued) return false;
  // Level 0 Anchor is strictly air-gapped and excluded from grace auto-signing
  if (!profile || isAnchor(profile) || profile.level === 0 || profile.derivation_index === 0) {
    return false;
  }

  // Credentials and presentation sharing always require explicit user review
  if (req.type === "sign_credential" || req.type === "POLY_CREDENTIAL_REQUEST") {
    return false;
  }

  // Nostr events: ONLY standard social note (kind: 1)
  if (req.type === "sign_event") {
    const kind = Number(req.event?.kind);
    return kind === 1;
  }

  // OIDC login challenges (type: "sign")
  if (req.type === "sign") {
    const challengeStr = (req.challenge || "").toLowerCase();
    // High-risk operations (master seed reveals, anchor exports, key rotations) must always ignore the grace timer
    if (
      challengeStr.includes("seed") ||
      challengeStr.includes("master") ||
      challengeStr.includes("anchor") ||
      challengeStr.includes("export") ||
      challengeStr.includes("rotate") ||
      challengeStr.includes("rotation") ||
      challengeStr.includes("burn")
    ) {
      return false;
    }
    return true;
  }

  return false;
}

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

function truncateDid(did: string, lead = 22, tail = 8): string {
  if (!did) return "";
  if (did.length <= lead + tail + 3) return did;
  return `${did.slice(0, lead)}...${did.slice(-tail)}`;
}

export interface WsSignPopupProps {
  isAppLocked?: boolean;
  authSessionValidUntil?: number;
}

export default function WsSignPopup({
  isAppLocked = false,
  authSessionValidUntil = 0,
}: WsSignPopupProps = {}) {
  const [request, setRequest] = useState<SignRequest | null>(null);
  const [_pendingRequest, setPendingRequest] = useState<SignRequest | null>(null);
  const pendingRequestRef = useRef<SignRequest | null>(null);

  const isAppLockedRef = useRef(isAppLocked);
  isAppLockedRef.current = isAppLocked;
  const authSessionValidUntilRef = useRef(authSessionValidUntil);
  authSessionValidUntilRef.current = authSessionValidUntil;
  const prevIsAppLockedRef = useRef(isAppLocked);

  const [isProcessing, setIsProcessing] = useState(false);
  const [autoSign, setAutoSign] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>("primary");
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const prevRequestRef = useRef<SignRequest | null>(null);

  const profilesRef = useRef<Profile[]>([]);
  profilesRef.current = profiles;
  const activeProfileIdRef = useRef<string>(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const selectedProfileIdRef = useRef<string>(selectedProfileId);
  selectedProfileIdRef.current = selectedProfileId;

  const resolveProfileForRequest = (reqProfileId?: string): Profile | undefined => {
    const list = profilesRef.current.length > 0 ? profilesRef.current : profiles;
    if (reqProfileId) {
      const match = list.find((p) => p.profile_id === reqProfileId);
      if (match) return match;
    }
    const targetId =
      selectedProfileIdRef.current ||
      activeProfileIdRef.current ||
      (list[0]?.profile_id ?? "primary");
    return (
      list.find((p) => p.profile_id === targetId) ||
      list.find((p) => p.profile_id === activeProfileIdRef.current) ||
      list[0]
    );
  };

  const effectiveSelectedId =
    selectedProfileId || activeProfileId || (profiles[0]?.profile_id ?? "primary");
  const currentSigningProfile =
    profiles.find((p) => p.profile_id === effectiveSelectedId) ||
    profiles.find((p) => p.profile_id === activeProfileId) ||
    profiles[0];

  const handleResponse = async (
    approved: boolean,
    targetReqArg?: SignRequest | null,
    targetProfileIdArg?: string | null,
  ) => {
    const activeReq = targetReqArg || request;
    if (!activeReq) return;
    if (activeReq.wasQueued) {
      activeReq.wasQueued = false;
    }
    setIsProcessing(true);

    const effectiveProfileId =
      targetProfileIdArg !== undefined
        ? targetProfileIdArg
        : (currentSigningProfile?.profile_id || activeProfileId || null);

    try {
      if (import.meta.env.DEV)
        console.log("[TAURI_SIGN] Triggering response submission with profile:", effectiveProfileId);

      if (activeReq.type === "sign_event") {
        await invoke("submit_ws_event_response", {
          eventJson: JSON.stringify(activeReq.event),
          approved,
          profileId: effectiveProfileId,
        });
        if (import.meta.env.DEV) console.log("REACT: submit_ws_event_response succeeded");
      } else if (activeReq.type === "sign_credential") {
        await invoke("submit_ws_credential_response", {
          credentialJson: JSON.stringify(activeReq.credential),
          holderDid: activeReq.holder_did,
          approved,
          profileId: effectiveProfileId,
        });
        if (import.meta.env.DEV) console.log("REACT: submit_ws_credential_response succeeded");
      } else if (activeReq.type === "POLY_CREDENTIAL_REQUEST") {
        await invoke("submit_ws_credential_presentation", {
          credentialType: activeReq.required_credential_type,
          challenge: activeReq.challenge,
          approved,
          profileId: effectiveProfileId,
        });
        if (import.meta.env.DEV) console.log("REACT: submit_ws_credential_presentation succeeded");
      } else {
        await invoke("submit_ws_response", {
          id: "",
          challenge: activeReq.challenge,
          approved,
          profileId: effectiveProfileId,
        });
        if (import.meta.env.DEV) console.log("REACT: submit_ws_response succeeded");
      }

      if (import.meta.env.DEV)
        console.log("[TAURI_SIGN] Submission accepted. Draining network buffers...");
      // Enforce a secure 250ms async hold window to allow the Rust TCP stack to flush cleanly
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (err) {
      console.error("[TAURI_ERROR] Core socket write failed:", err);
      setIsProcessing(false);
      setRequest(null);
      return;
    }

    setIsProcessing(false);
    setRequest(null);
  };

  const loadProfilesPromiseRef = useRef<Promise<Profile[]> | null>(null);

  const loadProfiles = (): Promise<Profile[]> => {
    const promise = (async () => {
      try {
        const [profilesList, activeDid] = await Promise.all([
          invoke<Profile[]>("list_profiles"),
          invoke<string | null>("get_active_did"),
        ]);

        const signable = (profilesList || []).filter(
          (p) => !isAnchor(p) && (p.level === undefined || p.level >= 1),
        );
        profilesRef.current = signable;
        setProfiles(signable);

        // Find the active profile among signable profiles
        let currentActiveId = "primary";
        if (activeDid) {
          const activeProfile = signable.find((p) => p.did === activeDid);
          if (activeProfile) {
            currentActiveId = activeProfile.profile_id;
          } else if (signable.length > 0) {
            currentActiveId = signable[0].profile_id;
          }
        } else if (signable.length > 0) {
          currentActiveId = signable[0].profile_id;
        }
        activeProfileIdRef.current = currentActiveId;
        setActiveProfileId(currentActiveId);
        return signable;
      } catch (err) {
        console.error("Failed to load profiles:", err);
        return [];
      }
    })();
    loadProfilesPromiseRef.current = promise;
    return promise;
  };

  useEffect(() => {
    const channel = new Channel<string>();
    channel.onmessage = async (data) => {
      if (import.meta.env.DEV) console.log("REACT: Received message via direct channel pipe:", data);
      let incomingReq: SignRequest;
      try {
        const parsed = JSON.parse(data);
        const profile_id = parsed.profile_id || undefined;
        if (parsed.__type__ === "sign_event") {
          incomingReq = { type: "sign_event", event: parsed.event, profile_id };
        } else if (parsed.__type__ === "sign_credential") {
          incomingReq = {
            type: "sign_credential",
            credential: parsed.credential,
            holder_did: parsed.holder_did,
            profile_id,
          };
        } else if (parsed.__type__ === "POLY_CREDENTIAL_REQUEST") {
          incomingReq = {
            type: "POLY_CREDENTIAL_REQUEST",
            required_credential_type: parsed.required_credential_type,
            challenge: parsed.challenge,
            profile_id,
          };
        } else if (parsed.__type__ === "sign") {
          incomingReq = { type: "sign", challenge: parsed.challenge, profile_id };
        } else {
          incomingReq = { type: "sign", challenge: data, profile_id };
        }
      } catch {
        incomingReq = { type: "sign", challenge: data };
      }

      if (isAppLockedRef.current) {
        if (import.meta.env.DEV)
          console.log("REACT: App is locked; stashing incoming challenge in pendingRequest");
        const queuedReq: SignRequest = { ...incomingReq, wasQueued: true };
        pendingRequestRef.current = queuedReq;
        setPendingRequest(queuedReq);
        return;
      }

      if (profilesRef.current.length === 0) {
        if (!loadProfilesPromiseRef.current) {
          loadProfilesPromiseRef.current = loadProfiles();
        }
        await loadProfilesPromiseRef.current;
      }

      const targetProfile = resolveProfileForRequest(incomingReq.profile_id);
      const now = Date.now();
      if (
        now < authSessionValidUntilRef.current &&
        isEligibleForGraceAutoSign(incomingReq, targetProfile)
      ) {
        if (import.meta.env.DEV)
          console.log("REACT: Session signing grace period active; auto-signing request without modal");
        handleResponse(true, incomingReq, targetProfile?.profile_id || null);
        return;
      }

      setRequest(incomingReq);
    };
    invoke("register_challenge_pipe", { channel });
    if (import.meta.env.DEV) console.log("REACT: Challenge channel registered with backend");

    // Load profiles and active profile
    loadProfiles();
  }, []);

  useEffect(() => {
    if (request && request !== prevRequestRef.current) {
      prevRequestRef.current = request;
      // Default to currently active profile
      setSelectedProfileId(activeProfileId || (profiles[0]?.profile_id ?? "primary"));
    }
  }, [request, activeProfileId, profiles]);

  // Handle lock state transitions
  useEffect(() => {
    // If transitioning from unlocked to locked: stash active request
    if (!prevIsAppLockedRef.current && isAppLocked) {
      if (request) {
        const queuedReq: SignRequest = { ...request, wasQueued: true };
        pendingRequestRef.current = queuedReq;
        setPendingRequest(queuedReq);
        setRequest(null);
      }
    }

    // If transitioning from locked to unlocked: reveal or auto-sign pending request
    if (prevIsAppLockedRef.current && !isAppLocked) {
      const pending = pendingRequestRef.current;
      if (pending) {
        pendingRequestRef.current = null;
        setPendingRequest(null);
        const processPending = async () => {
          if (profilesRef.current.length === 0) {
            if (!loadProfilesPromiseRef.current) {
              loadProfilesPromiseRef.current = loadProfiles();
            }
            await loadProfilesPromiseRef.current;
          }

          if (pending.wasQueued) {
            if (import.meta.env.DEV)
              console.log("REACT: Enclave unlocked; request was queued while locked, forcing manual review");
            setRequest(pending);
            return;
          }

          const targetProfile = resolveProfileForRequest(pending.profile_id);
          const now = Date.now();
          if (
            now < authSessionValidUntilRef.current &&
            isEligibleForGraceAutoSign(pending, targetProfile)
          ) {
            if (import.meta.env.DEV)
              console.log("REACT: Enclave unlocked with active grace period; auto-signing pending request");
            handleResponse(true, pending, targetProfile?.profile_id || null);
          } else {
            if (import.meta.env.DEV)
              console.log("REACT: Enclave unlocked; revealing pending request in modal");
            setRequest(pending);
          }
        };
        processPending();
      }
    }

    prevIsAppLockedRef.current = isAppLocked;
  }, [isAppLocked, authSessionValidUntil, request]);

  useEffect(() => {
    if (autoSign && request && !isProcessing) {
      const targetProfile = currentSigningProfile;
      if (targetProfile && isAnchor(targetProfile)) {
        console.warn("REACT: Auto-sign blocked for Anchor Level 0 identity");
        return;
      }
      if (import.meta.env.DEV) console.log("REACT: Auto-sign enabled, approving immediately");
      handleResponse(true);
    }
  }, [autoSign, request, currentSigningProfile, isProcessing]);

  if (isAppLocked || !request) return null;

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
              : request.type === "POLY_CREDENTIAL_REQUEST"
                ? "Credential Sharing Request"
                : "Signature Request"}
        </h2>

        {/* Persona Selector inside WsSignPopup */}
        {profiles.length > 0 && (
          <div
            className="persona-selector-section"
            style={{
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: "8px",
              padding: "0.85rem 1rem",
              margin: "1rem 0",
              display: "flex",
              flexDirection: "column",
              gap: "0.6rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.5rem",
              }}
            >
              <label
                htmlFor="signing-persona-select"
                style={{
                  fontWeight: 600,
                  fontSize: "0.9rem",
                  color: "#1e3a8a",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                <span>👤</span>
                <span>Signing Persona:</span>
              </label>
              <select
                id="signing-persona-select"
                aria-label="Signing Persona"
                value={effectiveSelectedId}
                onChange={(e) => setSelectedProfileId(e.target.value)}
                style={{
                  padding: "0.4rem 0.75rem",
                  borderRadius: "6px",
                  border: "1px solid #93c5fd",
                  background: "white",
                  fontSize: "0.85rem",
                  fontWeight: 500,
                  color: "#1e40af",
                  cursor: "pointer",
                }}
              >
                {profiles.map((p) => (
                  <option key={p.profile_id} value={p.profile_id}>
                    {p.profile_name} (Level {p.level ?? (p.derivation_index === 1 ? 1 : 2)})
                    {p.profile_id === activeProfileId ? " — Active" : ""}
                  </option>
                ))}
              </select>
            </div>

            {currentSigningProfile && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                  fontSize: "0.82rem",
                  color: "#1e40af",
                  background: "rgba(255, 255, 255, 0.8)",
                  padding: "0.45rem 0.65rem",
                  borderRadius: "6px",
                  border: "1px solid #dbeafe",
                }}
              >
                <div>
                  <span style={{ color: "#4b5563", marginRight: "0.35rem" }}>Profile Name:</span>
                  <strong style={{ color: "#1e3a8a" }}>{currentSigningProfile.profile_name}</strong>
                </div>
                <div>
                  <span style={{ color: "#4b5563", marginRight: "0.35rem" }}>DID:</span>
                  <span
                    style={{
                      fontFamily: "monospace",
                      fontSize: "0.8rem",
                      color: "#1f2937",
                    }}
                    title={currentSigningProfile.did}
                  >
                    {truncateDid(currentSigningProfile.did)}
                  </span>
                </div>
              </div>
            )}
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

        {request.type === "POLY_CREDENTIAL_REQUEST" && (
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
          {import.meta.env.DEV && (
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
          )}
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
                : request.type === "POLY_CREDENTIAL_REQUEST"
                  ? "Share Asset"
                  : "Approve & Sign"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
