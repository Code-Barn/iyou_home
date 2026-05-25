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
import { readText } from "@tauri-apps/plugin-clipboard-manager";

interface Profile {
  profile_id: string;
  profile_name: string;
  derivation_index: number;
  did: string;
}

// Note: In the future, we can import init, { verify_vp } from '../lib/did_rust_wasm/did_rust.js'
// to locally verify the created VP in WASM before returning it to the user.

export default function SovereignSigner() {
  const [activeDid, setActiveDid] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [challenge, setChallenge] = useState("");
  const [presentation, setPresentation] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchActiveDid();
    fetchProfiles();
  }, []);

  const fetchActiveDid = async () => {
    try {
      const did = await invoke<string | null>("get_active_did");
      setActiveDid(did);
    } catch (err: any) {
      console.error("Failed to fetch active DID:", err);
    }
  };

  const fetchProfiles = async () => {
    try {
      const list = await invoke<Profile[]>("list_profiles");
      setProfiles(list);
      // Set default selected profile to active one if available
      if (list.length > 0) {
        const activeProfile = list.find((p) => p.did === activeDid) || list[0];
        setSelectedProfileId(activeProfile.profile_id);
      }
    } catch (err: any) {
      console.error("Failed to fetch profiles:", err);
      setError(`Failed to load profiles: ${err.toString()}`);
    }
  };

  const handlePasteFromClipboard = async () => {
    setError(null);
    try {
      const text = await readText();
      if (!text) {
        setError("Clipboard is empty.");
        return;
      }

      try {
        const json = JSON.parse(text);
        if (json.challenge) {
          setChallenge(json.challenge);
          return;
        }
      } catch (e) {}

      setChallenge(text);
    } catch (err: any) {
      const msg = err.toString();
      if (
        msg.toLowerCase().includes("not allowed") ||
        msg.toLowerCase().includes("permission denied")
      ) {
        setError(
          "Clipboard access denied. Grant clipboard permission in your OS settings or paste manually.",
        );
      } else {
        setError(`Failed to read clipboard: ${msg}`);
      }
    }
  };

  const handleSign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDid) {
      setError("No active identity found. Please go to the Keys tab.");
      return;
    }

    setIsSigning(true);
    setError(null);
    setPresentation(null);

    try {
      const vpJson = await invoke<string>("sign_auth_challenge", {
        challenge: challenge,
        didId: activeDid,
        profileId: selectedProfileId,
      });
      // Format the returned JSON for nice display
      const parsedVp = JSON.parse(vpJson);
      setPresentation(JSON.stringify(parsedVp, null, 2));
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsSigning(false);
    }
  };

  return (
    <div className="component-container">
      <h2>Sovereign Signer</h2>
      <p>Sign an authentication challenge using your secure Vault identity.</p>

      {error && <div className="error-message">{error}</div>}

      <form onSubmit={handleSign} className="section sign-form">
        <div className="form-group">
          <label>Signer Identity</label>
          <div className="did-display muted">
            {activeDid ? activeDid : "No active identity (Check Keys tab)"}
          </div>
        </div>

        {profiles.length > 0 && (
          <div className="form-group">
            <label>Signing Profile</label>
            <select
              value={selectedProfileId}
              onChange={(e) => setSelectedProfileId(e.target.value)}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid #ccc",
                fontSize: "0.9rem",
                marginTop: "0.5rem",
              }}
            >
              {profiles.map((profile) => (
                <option key={profile.profile_id} value={profile.profile_id}>
                  {profile.profile_name} (Index: {profile.derivation_index})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="form-group">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <label>IdP Challenge (JSON or String)</label>
            <button
              type="button"
              onClick={handlePasteFromClipboard}
              style={{
                padding: "0.2rem 0.5rem",
                fontSize: "0.8rem",
              }}
            >
              📋 Paste
            </button>
          </div>
          <textarea
            value={challenge}
            onChange={(e) => setChallenge(e.target.value)}
            placeholder='e.g., "auth-challenge-uuid-1234"'
            rows={4}
            required
            style={{ marginTop: "0.5rem" }}
          />
        </div>

        <button type="submit" disabled={isSigning || !activeDid || !challenge}>
          {isSigning ? "Signing in Secure Enclave..." : "Sign Challenge"}
        </button>
      </form>

      {presentation && (
        <div className="section result">
          <h3>Verifiable Presentation (VP)</h3>
          <p className="success-text">Successfully signed by Vault.</p>
          <pre className="json-display">{presentation}</pre>
        </div>
      )}
    </div>
  );
}
