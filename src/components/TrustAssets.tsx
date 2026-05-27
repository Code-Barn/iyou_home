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
import { invoke } from "@tauri-apps/api/core";

interface VaultCredential {
  vc_id: string;
  issuer_did: string;
  subject_did: string;
  credential_type: string;
  fidelity_score?: number | null;
  expiration_date?: string | null;
  raw_payload: string;
}

interface Profile {
  profile_id: string;
  profile_name: string;
  derivation_index: number;
  did: string;
}

function fidelityBadge(score: number | null | undefined): {
  label: string;
  tierClass: string;
} | null {
  if (score == null) return null;
  const tier = Math.round(score);
  switch (tier) {
    case 1:
      return {
        label: "Tier 1: Social Peer Vouched",
        tierClass: "tier1",
      };
    case 2:
      return {
        label: "Tier 2: Institutional Registry Vouched",
        tierClass: "tier2",
      };
    case 3:
      return {
        label: "Tier 3: Secure Hardware Anchor Vouched",
        tierClass: "tier3",
      };
    default:
      return null;
  }
}

function isExpired(expirationDate: string | null | undefined): boolean {
  if (!expirationDate) return false;
  const exp = new Date(expirationDate);
  if (isNaN(exp.getTime())) return false;
  return exp < new Date();
}

export default function TrustAssets() {
  const [credentials, setCredentials] = useState<VaultCredential[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeDid, setActiveDid] = useState<string | null>(null);
  const [modalCredential, setModalCredential] =
    useState<VaultCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const activeProfile = profiles.find((p) => p.did === activeDid) || null;
  const activeProfileId = activeProfile?.profile_id || "";

  useEffect(() => {
    const fetchInitial = async () => {
      setLoading(true);
      setError(null);
      try {
        const [did, profileList] = await Promise.all([
          invoke<string | null>("get_active_did"),
          invoke<Profile[]>("list_profiles"),
        ]);
        setActiveDid(did);
        setProfiles(profileList);

        const profile =
          profileList.find((p) => p.did === did) || profileList[0];
        if (profile) {
          const creds = await invoke<VaultCredential[]>("get_credentials", {
            profileId: profile.profile_id,
          });
          setCredentials(creds || []);
        } else {
          setCredentials([]);
        }
      } catch (err: any) {
        setError(err.toString());
        setCredentials([]);
      } finally {
        setLoading(false);
      }
    };
    fetchInitial();
  }, []);

  useEffect(() => {
    if (!activeDid || profiles.length === 0) return;
    const profile =
      profiles.find((p) => p.did === activeDid) || profiles[0];
    if (!profile) return;
    const refreshCredentials = async () => {
      setError(null);
      try {
        const creds = await invoke<VaultCredential[]>("get_credentials", {
          profileId: profile.profile_id,
        });
        setCredentials(creds || []);
      } catch (err: any) {
        setError(err.toString());
      }
    };
    refreshCredentials();
  }, [activeDid]);

  const activeProfileName = activeProfile?.profile_name || "Unknown";

  return (
    <div className="component-container">
      <h2>Trust Assets & Credentials</h2>

      <div className="vault-badge">
        Active Persona: {activeProfileName}
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="section">
          <p className="muted">Loading credentials...</p>
        </div>
      ) : credentials.length === 0 ? (
        <div className="section">
          <p className="muted">
            No credentials stored for this persona.
          </p>
        </div>
      ) : (
        credentials.map((cred) => {
          const expired = isExpired(cred.expiration_date);
          const didMismatch =
            !!activeProfile && cred.subject_did !== activeProfile.did;
          const badge = fidelityBadge(cred.fidelity_score);

          return (
            <div
              key={cred.vc_id}
              className={`section credential-card ${expired ? "expired" : ""}`}
            >
              <div className="credential-header">
                <h3 style={{ margin: 0, fontSize: "1rem" }}>
                  {cred.credential_type}
                </h3>
                {badge && (
                  <span className={`fidelity-badge ${badge.tierClass}`}>
                    {badge.label}
                  </span>
                )}
                {expired && (
                  <span className="expired-badge">EXPIRED</span>
                )}
              </div>

              {expired && (
                <div className="expired-banner">
                  [EXPIRED Lease - Re-verification Required]
                </div>
              )}

              {didMismatch && (
                <div className="critical-alert">
                  ⚠️ Identity Mismatch: credential subject DID does not match
                  active profile.
                  <br />
                  <small>
                    Credential: {cred.subject_did}
                    <br />
                    Active: {activeProfile?.did}
                  </small>
                </div>
              )}

              <div className="credential-meta">
                <div>
                  <strong>Issuer:</strong>{" "}
                  <code>{cred.issuer_did}</code>
                </div>
                <div>
                  <strong>Subject:</strong>{" "}
                  <code>{cred.subject_did}</code>
                </div>
                <div>
                  <strong>Expiration:</strong>{" "}
                  {cred.expiration_date || "Never"}
                </div>
              </div>

              <button onClick={() => setModalCredential(cred)}>
                Inspect Cryptographic Evidence Document
              </button>
            </div>
          );
        })
      )}

      {modalCredential && (
        <div
          className="modal-overlay"
          onClick={() => setModalCredential(null)}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Cryptographic Evidence Document</h3>
            <pre className="json-display">
              {modalCredential.raw_payload}
            </pre>
            <div style={{ marginTop: "1rem", textAlign: "right" }}>
              <button onClick={() => setModalCredential(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
