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
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Profile } from "../lib/types";
import { isExternallySignable } from "../lib/enclaveFilters";

interface VaultCredential {
  vc_id: string;
  issuer_did: string;
  subject_did: string;
  credential_type: string;
  fidelity_score?: number | null;
  expiration_date?: string | null;
  raw_payload: string;
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

function levelLabel(level: number): string {
  if (level === 0) return "L0 Anchor";
  if (level === 1) return "L1 Public";
  return `L${level} Burner`;
}

const EMAIL_OWNERSHIP_TYPE = "EmailOwnershipCredential";

export type EmailCategory = "personal" | "work" | "alias" | "unknown";

interface EmailOwnershipInfo {
  email: string | null;
  emailCategory: EmailCategory;
  verifiedAt: string | null;
  issuer: string | null;
}

/**
 * Detect an iyou_idp `EmailOwnershipCredential` and project its subject fields.
 *
 * The vault's `VaultCredential` row has no dedicated column for `email_type` or
 * `verified_at`, so both live only inside `raw_payload`. Type detection is
 * deliberately redundant: the `import_verifiable_credential` path records
 * `credential_type === "EmailOwnershipCredential"`, but the `save_credential`
 * path records the first entry of the `type` array, which for this credential is
 * `"VerifiableCredential"`. Checking both keeps the card rendering stable
 * regardless of which import path stored it.
 *
 * Returns `null` only for a non-EmailOwnershipCredential, or when `raw_payload`
 * is not parseable JSON at all — callers render the generic card in that case.
 *
 * A recognized EmailOwnershipCredential whose `credentialSubject` is missing or
 * missing individual fields still returns a populated record: the card renders
 * with explicit "— not disclosed —" placeholders and an `unknown` category
 * badge. That is deliberate, so an issuer-signed-but-incomplete email claim is
 * visibly incomplete rather than silently indistinguishable from a
 * non-email credential.
 */
export function extractEmailOwnership(
  cred: Pick<VaultCredential, "credential_type" | "raw_payload">,
): EmailOwnershipInfo | null {
  let parsed: any;
  try {
    parsed = JSON.parse(cred.raw_payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const rawTypes: unknown[] = Array.isArray(parsed.type)
    ? parsed.type
    : typeof parsed.type === "string"
      ? [parsed.type]
      : [];

  const isEmailOwnership =
    cred.credential_type === EMAIL_OWNERSHIP_TYPE ||
    rawTypes.includes(EMAIL_OWNERSHIP_TYPE);
  if (!isEmailOwnership) return null;

  const subject =
    parsed.credentialSubject && typeof parsed.credentialSubject === "object"
      ? parsed.credentialSubject
      : null;

  const issuerRaw =
    typeof parsed.issuer === "string"
      ? parsed.issuer
      : parsed.issuer && typeof parsed.issuer === "object"
        ? parsed.issuer.id
        : null;

  const rawCategory = typeof subject?.email_type === "string" ? subject.email_type.toLowerCase() : "";

  return {
    email: typeof subject?.email === "string" && subject.email ? subject.email : null,
    emailCategory:
      rawCategory === "personal" || rawCategory === "work" || rawCategory === "alias"
        ? rawCategory
        : "unknown",
    verifiedAt:
      typeof subject?.verified_at === "string" && subject.verified_at
        ? subject.verified_at
        : null,
    issuer: typeof issuerRaw === "string" && issuerRaw ? issuerRaw : null,
  };
}

function emailCategoryBadge(category: EmailCategory): {
  label: string;
  style: CSSProperties;
} {
  switch (category) {
    case "personal":
      return {
        label: "personal",
        style: { background: "#d1fae5", color: "#065f46", border: "1px solid #6ee7b7" },
      };
    case "work":
      return {
        label: "work",
        style: { background: "#fef3c7", color: "#92400e", border: "1px solid #fcd34d" },
      };
    case "alias":
      return {
        label: "alias",
        style: { background: "#e0f2fe", color: "#075985", border: "1px solid #7dd3fc" },
      };
    default:
      return {
        label: "unknown",
        style: { background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1" },
      };
  }
}

export default function TrustAssets() {
  const [allCredentials, setAllCredentials] = useState<VaultCredential[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [modalCredential, setModalCredential] =
    useState<VaultCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Import Modal State
  const [showImportModal, setShowImportModal] = useState(false);
  const [importProfileId, setImportProfileId] = useState<string>("");
  const [importPayload, setImportPayload] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const signableProfiles = profiles.filter(isExternallySignable);

  const selectedProfile =
    signableProfiles.find((p) => p.profile_id === selectedProfileId) ||
    signableProfiles[0] ||
    null;

  // Load profiles on mount
  useEffect(() => {
    const fetchProfiles = async () => {
      setLoading(true);
      setError(null);
      try {
        const [did, profileList] = await Promise.all([
          invoke<string | null>("get_active_did"),
          invoke<Profile[]>("list_profiles"),
        ]);
        setProfiles(profileList);

        const signable = profileList.filter(isExternallySignable);
        // Pre-select the active profile if it's signable, otherwise first signable
        const activeProfile = signable.find((p) => p.did === did);
        setSelectedProfileId(
          activeProfile?.profile_id || signable[0]?.profile_id || "",
        );
      } catch (err: any) {
        setError(err.toString());
      } finally {
        setLoading(false);
      }
    };
    fetchProfiles();
  }, []);

  // Load credentials when selected profile changes
  useEffect(() => {
    if (!selectedProfile) {
      setAllCredentials([]);
      return;
    }
    const fetchCredentials = async () => {
      setError(null);
      try {
        const creds = await invoke<VaultCredential[]>("get_credentials", {
          profileId: selectedProfile.profile_id,
        });
        setAllCredentials(creds || []);
      } catch (err: any) {
        setError(err.toString());
        setAllCredentials([]);
      }
    };
    fetchCredentials();
  }, [selectedProfile]);

  const openImportModal = () => {
    setImportProfileId(selectedProfile?.profile_id || signableProfiles[0]?.profile_id || "");
    setImportPayload("");
    setImportError(null);
    setShowImportModal(true);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setImportPayload(content);
        setImportError(null);
      }
    };
    reader.onerror = () => {
      setImportError("Failed to read file");
    };
    reader.readAsText(file);
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importPayload.trim()) {
      setImportError("Please provide a Verifiable Credential JSON payload.");
      return;
    }
    if (!importProfileId) {
      setImportError("Please select a target persona.");
      return;
    }
    setImportLoading(true);
    setImportError(null);
    try {
      await invoke("import_verifiable_credential", {
        profileId: importProfileId,
        vcPayload: importPayload.trim(),
      });
      setSuccessMessage("✅ Credential imported successfully.");
      setTimeout(() => setSuccessMessage(null), 4000);
      setShowImportModal(false);

      // Reload credentials for the updated profile
      if (selectedProfile?.profile_id === importProfileId) {
        const creds = await invoke<VaultCredential[]>("get_credentials", {
          profileId: importProfileId,
        });
        setAllCredentials(creds || []);
      } else {
        setSelectedProfileId(importProfileId);
      }
    } catch (err: any) {
      setImportError(err.toString());
    } finally {
      setImportLoading(false);
    }
  };

  const filteredCredentials = allCredentials.filter((cred) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      cred.credential_type.toLowerCase().includes(q) ||
      cred.issuer_did.toLowerCase().includes(q) ||
      cred.vc_id.toLowerCase().includes(q)
    );
  });

  return (
    <div className="component-container">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Trust Assets &amp; Credentials</h2>
        <button
          onClick={openImportModal}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.85rem",
            fontWeight: 600,
          }}
        >
          + Import Credential
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {successMessage && (
        <div
          style={{
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#166534",
            padding: "0.75rem 1rem",
            borderRadius: "6px",
            marginBottom: "1rem",
            fontSize: "0.9rem",
            fontWeight: 500,
          }}
        >
          {successMessage}
        </div>
      )}

      {/* Sovereign Credential Repository Callout */}
      <div
        style={{
          background: "var(--color-bg-secondary, #f8fafc)",
          border: "1px solid var(--color-border, #e2e8f0)",
          borderRadius: "8px",
          padding: "0.85rem 1.15rem",
          marginBottom: "1rem",
          fontSize: "0.82rem",
          color: "var(--color-text-secondary, #475569)",
          lineHeight: "1.5",
        }}
      >
        <strong>Sovereign Credential Repository:</strong> Store and manage official W3C Verifiable Credentials issued to your personas—including civic voting eligibility (<code>iyou_poly</code>), professional licenses (<code>iyou_talk</code>), emergency certifications (<code>iyou_safe</code>), and peer vouchers.
      </div>

      {/* Controls row: persona selector + search */}
      <div
        style={{
          display: "flex",
          gap: "1rem",
          alignItems: "flex-end",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div className="form-group" style={{ flex: 1, minWidth: "200px", marginBottom: 0 }}>
          <label>Persona</label>
          <select
            value={selectedProfileId}
            onChange={(e) => setSelectedProfileId(e.target.value)}
          >
            {signableProfiles.map((p) => (
              <option key={p.profile_id} value={p.profile_id}>
                {p.profile_name} ({levelLabel(p.level)})
              </option>
            ))}
            {signableProfiles.length === 0 && (
              <option value="">No signable personas</option>
            )}
          </select>
        </div>

        <div className="form-group" style={{ flex: 1, minWidth: "200px", marginBottom: 0 }}>
          <label>Search Credentials</label>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by type, issuer, or ID..."
          />
        </div>
      </div>

      {loading ? (
        <div className="section">
          <p className="muted">Loading credentials...</p>
        </div>
      ) : filteredCredentials.length === 0 ? (
        <div className="section" style={{ textAlign: "center", padding: "2rem" }}>
          {allCredentials.length === 0 ? (
            <>
              <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
                No credentials stored for this persona.
              </p>
              <p className="muted" style={{ margin: "0 auto", maxWidth: "600px", lineHeight: "1.5" }}>
                Verifiable Credentials represent official proofs issued to you—such as voting eligibility (iyou_poly), professional licenses (iyou_talk), emergency certifications (iyou_safe), or peer vouchers. Import a credential above or receive one automatically from satellite apps.
              </p>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              No credentials match your search query.
            </p>
          )}
        </div>
      ) : (
        filteredCredentials.map((cred) => {
          const expired = isExpired(cred.expiration_date);
          const didMismatch =
            !!selectedProfile && cred.subject_did !== selectedProfile.did;
          const badge = fidelityBadge(cred.fidelity_score);
          const emailInfo = extractEmailOwnership(cred);

          return (
            <div
              key={cred.vc_id}
              className={`section credential-card ${expired ? "expired" : ""}`}
            >
              <div className="credential-header">
                <h3 style={{ margin: 0, fontSize: "1rem" }}>
                  {emailInfo ? "Email Ownership" : cred.credential_type}
                </h3>
                {emailInfo
                  ? (() => {
                      const cat = emailCategoryBadge(emailInfo.emailCategory);
                      return (
                        <span
                          className="email-category-badge"
                          data-testid="email-category-badge"
                          style={{
                            ...cat.style,
                            padding: "0.15rem 0.55rem",
                            borderRadius: "999px",
                            fontSize: "0.72rem",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.03em",
                          }}
                        >
                          {cat.label}
                        </span>
                      );
                    })()
                  : badge && (
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
                    Active: {selectedProfile?.did}
                  </small>
                </div>
              )}

              {emailInfo ? (
                <div className="credential-meta">
                  <div>
                    <strong>Verified Email:</strong>{" "}
                    <code data-testid="email-ownership-email">
                      {emailInfo.email ?? "— not disclosed —"}
                    </code>
                  </div>
                  <div>
                    <strong>Issuer:</strong>{" "}
                    <code>{emailInfo.issuer ?? cred.issuer_did}</code>
                  </div>
                  <div>
                    <strong>Verified:</strong>{" "}
                    <span data-testid="email-ownership-verified-at">
                      {emailInfo.verifiedAt ?? "— not disclosed —"}
                    </span>
                  </div>
                </div>
              ) : (
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
              )}

              <button onClick={() => setModalCredential(cred)}>
                View Raw Credential
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
            <h3>Raw Credential</h3>
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

      {/* ========== Import Credential Modal ========== */}
      {showImportModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!importLoading) setShowImportModal(false);
          }}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "560px" }}
          >
            <h3>📜 Import Verifiable Credential</h3>
            <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>
              Import a W3C-compliant signed Verifiable Credential into your sovereign vault.
            </p>

            {importError && (
              <div className="error-message" style={{ marginBottom: "1rem" }}>
                {importError}
              </div>
            )}

            <form onSubmit={handleImportSubmit}>
              <div className="form-group">
                <label>Target Persona</label>
                <select
                  value={importProfileId}
                  onChange={(e) => setImportProfileId(e.target.value)}
                >
                  {signableProfiles.map((p) => (
                    <option key={p.profile_id} value={p.profile_id}>
                      {p.profile_name} ({levelLabel(p.level)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.25rem",
                  }}
                >
                  <label style={{ margin: 0 }}>Credential Payload (JSON)</label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--color-primary, #4f46e5)",
                      cursor: "pointer",
                      fontSize: "0.8rem",
                      padding: 0,
                      textDecoration: "underline",
                    }}
                  >
                    📁 Upload .json Credential File
                  </button>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    accept=".json,application/json"
                    style={{ display: "none" }}
                  />
                </div>
                <textarea
                  rows={8}
                  value={importPayload}
                  onChange={(e) => {
                    setImportPayload(e.target.value);
                    setImportError(null);
                  }}
                  placeholder="Paste raw W3C Verifiable Credential JSON payload..."
                  style={{
                    width: "100%",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    padding: "0.5rem",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                    boxSizing: "border-box",
                  }}
                  required
                />
              </div>

              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  marginTop: "1rem",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  disabled={importLoading}
                  style={{
                    background: "#f3f4f6",
                    border: "1px solid #d1d5db",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={importLoading || !importPayload.trim()}
                  style={{
                    background: "var(--color-success, #16a34a)",
                    color: "white",
                    fontWeight: 600,
                  }}
                >
                  {importLoading ? "Verifying & Saving..." : "Verify & Save to Vault"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
