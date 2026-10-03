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
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Profile, PeerContact } from "../../lib/types";

interface DisclosureModalProps {
  isOpen: boolean;
  onClose: () => void;
  profiles: Profile[];
  contacts: PeerContact[];
  onRefresh: () => void | Promise<void>;
}

/**
 * Email categories disclosed by default for each trust tier.
 *
 * `Level1` peers are omitted by default: a disclosure card is a durable signed
 * artifact that a peer can retain and correlate, so email is never volunteered
 * to an unvetted peer without the user explicitly opting in per-credential.
 */
const TIER_DEFAULT_EMAIL_CATEGORIES: Record<string, string[]> = {
  level0: ["personal"],
  // Normalized `Level0_5` / `level0_5` collapses to `level05` (the underscore is
  // stripped), which is why this key is not spelled `level0_5`.
  level05: ["work"],
  level1: [],
};

/**
 * Normalize a trust tier to a stable comparison key.
 *
 * Wire values are dual-cased across the codebase: the Rust `TrustLevel` enum
 * serializes `Level0` / `Level0_5` / `Level1`, while stored contacts and older
 * fixtures use `level0` / `level0_5` / `level1`. Lowercasing and stripping
 * non-alphanumerics collapses `Level0_5` and `level0_5` to the same key.
 */
function normalizeTrustLevel(trustLevel: string | undefined | null): string {
  return String(trustLevel || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Categories defaulted for a contact's trust tier; unknown tiers disclose nothing. */
export function defaultEmailCategoriesForTrustLevel(
  trustLevel: string | undefined | null,
): string[] {
  return TIER_DEFAULT_EMAIL_CATEGORIES[normalizeTrustLevel(trustLevel)] ?? [];
}

interface EmailOwnershipCredentialOption {
  vc_id: string;
  email: string | null;
  email_type: string;
  verified_at: string | null;
}

/**
 * Project EmailOwnershipCredential rows into selectable options.
 *
 * Only credentials whose `type` array includes `EmailOwnershipCredential` are
 * returned; `email_type` and `verified_at` are read from `raw_payload` because
 * the vault's credential row carries no dedicated column for them. Rows with an
 * unparseable payload are skipped rather than surfaced as blank rows.
 */
export function toEmailOwnershipOptions(
  creds: Array<Record<string, unknown>>,
): EmailOwnershipCredentialOption[] {
  const out: EmailOwnershipCredentialOption[] = [];
  for (const cred of creds || []) {
    const rawPayload = typeof cred?.raw_payload === "string" ? cred.raw_payload : "";
    let parsed: Record<string, any> | null = null;
    try {
      parsed = rawPayload ? JSON.parse(rawPayload) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    const rawTypes: unknown[] = Array.isArray(parsed.type)
      ? parsed.type
      : typeof parsed.type === "string"
        ? [parsed.type]
        : [];

    const isEmailOwnership =
      cred?.credential_type === "EmailOwnershipCredential" ||
      rawTypes.includes("EmailOwnershipCredential");
    if (!isEmailOwnership) continue;

    const subject =
      parsed.credentialSubject && typeof parsed.credentialSubject === "object"
        ? parsed.credentialSubject
        : {};

    out.push({
      vc_id: String(cred.vc_id ?? ""),
      email: typeof subject.email === "string" && subject.email ? subject.email : null,
      email_type:
        typeof subject.email_type === "string" && subject.email_type
          ? subject.email_type.toLowerCase()
          : "unknown",
      verified_at:
        typeof subject.verified_at === "string" && subject.verified_at
          ? subject.verified_at
          : null,
    });
  }
  return out;
}

export default function DisclosureModal({
  isOpen,
  onClose,
  profiles,
  contacts,
  onRefresh,
}: DisclosureModalProps) {
  const [activeTab, setActiveTab] = useState<"generate" | "import">("generate");

  // Tab 1 (Generate) State
  const defaultProfile =
    profiles.find((p) => p.level === 1 || p.derivation_index === 1) ||
    profiles[0];
  const [signingProfileId, setSigningProfileId] = useState<string>(
    defaultProfile?.profile_id || "",
  );
  const [displayName, setDisplayName] = useState("");
  const [targetPeerDid, setTargetPeerDid] = useState("");
  const [selectedTier, setSelectedTier] = useState<string>("Tier 0 Inner Circle");
  const [selectedPersonaAliases, setSelectedPersonaAliases] = useState<string[]>([]);
  const [additionalAliases, setAdditionalAliases] = useState("");
  const [generatedCardJson, setGeneratedCardJson] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);

  // EmailOwnershipCredential disclosure state
  const [emailOptions, setEmailOptions] = useState<EmailOwnershipCredentialOption[]>([]);
  const [selectedEmailVcIds, setSelectedEmailVcIds] = useState<string[]>([]);

  // Resolve the target contact from the free-text DID field so email defaults
  // follow the *contact's* trust tier rather than the cosmetic tier dropdown.
  const targetContact = contacts.find(
    (c) => c.peer_id === targetPeerDid.trim(),
  );
  const targetTrustLevel = targetContact?.trust_level ?? null;

  // Load EmailOwnershipCredentials for the signing persona whenever it changes.
  useEffect(() => {
    let cancelled = false;
    if (!signingProfileId) {
      setEmailOptions([]);
      return;
    }
    const load = async () => {
      try {
        const creds = await invoke<Array<Record<string, unknown>>>("get_credentials", {
          profileId: signingProfileId,
        });
        if (!cancelled) setEmailOptions(toEmailOwnershipOptions(creds || []));
      } catch {
        // A missing/failed credential read must not block card generation;
        // the card simply discloses no email claims.
        if (!cancelled) setEmailOptions([]);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [signingProfileId]);

  /**
   * Apply trust-tier defaults for the current disclosure context.
   *
   * The context is the pair (target contact, available credential set). Keying on
   * both — rather than on the contact alone — matters because the credential
   * fetch is async: if the user picks a contact *before* `get_credentials`
   * resolves, keying on the contact alone would latch the empty selection and
   * permanently skip the tier default once the credentials arrived.
   *
   * Re-applying is skipped while the context is unchanged, so manual checkbox
   * toggles within one contact survive re-renders and credential refetches.
   */
  const emailContextKey = `${targetContact?.peer_id ?? "none"}::${emailOptions
    .map((o) => o.vc_id)
    .join(",")}`;
  const lastEmailContextRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (lastEmailContextRef.current === emailContextKey) return;
    lastEmailContextRef.current = emailContextKey;

    // A new context supersedes any manual overrides from the previous one.
    const defaults = defaultEmailCategoriesForTrustLevel(targetTrustLevel);
    setSelectedEmailVcIds(
      emailOptions.filter((o) => defaults.includes(o.email_type)).map((o) => o.vc_id),
    );
  }, [isOpen, emailContextKey, emailOptions, targetTrustLevel]);

  // Tab 2 (Import) State
  const [importJsonText, setImportJsonText] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<PeerContact | null>(null);

  useEffect(() => {
    if (!signingProfileId && profiles.length > 0) {
      const preferred =
        profiles.find((p) => p.level === 1 || p.derivation_index === 1) ||
        profiles[0];
      if (preferred) {
        setSigningProfileId(preferred.profile_id);
      }
    }
  }, [profiles, signingProfileId]);

  if (!isOpen) return null;

  const copyToClipboard = async (text: string) => {
    try {
      await writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2500);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2500);
      } catch (e) {
        console.error("Clipboard copy failed:", e);
      }
    }
  };

  const handleTogglePersonaAlias = (aliasToken: string) => {
    setSelectedPersonaAliases((prev) =>
      prev.includes(aliasToken)
        ? prev.filter((a) => a !== aliasToken)
        : [...prev, aliasToken],
    );
  };

  const handleToggleEmailCredential = (vcId: string) => {
    setSelectedEmailVcIds((prev) =>
      prev.includes(vcId) ? prev.filter((id) => id !== vcId) : [...prev, vcId],
    );
  };

  const handleGenerateCard = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGenerating(true);
    setGenerateError(null);
    setGeneratedCardJson(null);

    // Collect all aliases to disclose
    const extra = additionalAliases
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const allAliases = Array.from(
      new Set([...selectedPersonaAliases, ...extra]),
    );

    // Only explicitly-selected email claims are attached. Manual deselection
    // of a trust-tier default is honored here, since this reads the live
    // checkbox state rather than recomputing the tier default.
    const selectedEmailCredentials = emailOptions
      .filter((o) => selectedEmailVcIds.includes(o.vc_id))
      .map((o) => ({
        vc_id: o.vc_id,
        email: o.email,
        email_type: o.email_type,
        verified_at: o.verified_at,
      }));

    const selectedProfile =
      profiles.find((p) => p.profile_id === signingProfileId) ||
      profiles.find((p) => p.level === 1 || p.derivation_index === 1) ||
      profiles[0];
    const name =
      displayName.trim() || selectedProfile?.profile_name || "Sovereign Peer";

    try {
      const cardJson = await invoke<string>("generate_disclosure_card", {
        profileId: selectedProfile?.profile_id || null,
        targetPeerDid: targetPeerDid.trim() || null,
        displayName: name,
        disclosedAliases: allAliases,
        tier: selectedTier,
        disclosedEmailCredentials: selectedEmailCredentials,
      });

      const parsed = JSON.parse(cardJson);
      setGeneratedCardJson(JSON.stringify(parsed, null, 2));
    } catch (err: any) {
      setGenerateError(err.toString());
    } finally {
      setIsGenerating(false);
    }
  };

  const handleImportCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importJsonText.trim()) {
      setImportError("Please paste a disclosure card JSON payload.");
      return;
    }
    setIsImporting(true);
    setImportError(null);
    setImportSuccess(null);

    try {
      const storedContact = await invoke<PeerContact>("import_disclosure_card", {
        cardJson: importJsonText.trim(),
        disclosureJson: importJsonText.trim(),
        disclosure_json: importJsonText.trim(),
      });

      setImportSuccess(storedContact);
      setImportJsonText("");
      await onRefresh();
    } catch (err: any) {
      setImportError(err.toString());
    } finally {
      setIsImporting(false);
    }
  };

  const handleDownloadJson = () => {
    if (!generatedCardJson) return;
    const blob = new Blob([generatedCardJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `disclosure_card_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "720px", width: "95%" }}
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
            <span style={{ fontSize: "1.4rem" }}>🪪</span>
            <h3 style={{ margin: 0 }}>Selective Disclosure Cards</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              boxShadow: "none",
              fontSize: "1.2rem",
              cursor: "pointer",
              padding: "0.2rem 0.5rem",
            }}
          >
            ✕
          </button>
        </div>

        {/* Modal Tab Switcher */}
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginBottom: "1.25rem",
            borderBottom: "2px solid #e5e7eb",
            paddingBottom: "0.5rem",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setActiveTab("generate");
              setGenerateError(null);
            }}
            style={{
              padding: "0.5rem 1rem",
              background: activeTab === "generate" ? "#7c3aed" : "#f3f4f6",
              color: activeTab === "generate" ? "white" : "#374151",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            Generate Disclosure Card
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab("import");
              setImportError(null);
            }}
            style={{
              padding: "0.5rem 1rem",
              background: activeTab === "import" ? "#7c3aed" : "#f3f4f6",
              color: activeTab === "import" ? "white" : "#374151",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              fontSize: "0.85rem",
            }}
          >
            Import Peer Card
          </button>
        </div>

        {/* TAB 1: GENERATE */}
        {activeTab === "generate" && (
          <div>
            <p style={{ fontSize: "0.85rem", color: "#4b5563", marginTop: 0 }}>
              Issue a cryptographically signed Verifiable Attestation Card to
              introduce yourself to a peer and selectively disclose aliases and
              burner keys.
            </p>

            {generateError && <div className="error-message">{generateError}</div>}

            <form onSubmit={handleGenerateCard}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1rem",
                  marginBottom: "1rem",
                }}
              >
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Signing Profile</label>
                  <select
                    value={signingProfileId}
                    onChange={(e) => {
                      setSigningProfileId(e.target.value);
                      const p = profiles.find(
                        (prof) => prof.profile_id === e.target.value,
                      );
                      if (p && !displayName) {
                        setDisplayName(p.profile_name);
                      }
                    }}
                    style={{
                      padding: "0.6rem",
                      borderRadius: "4px",
                      border: "1px solid #ccc",
                      fontSize: "0.9rem",
                    }}
                  >
                    {profiles.map((p) => (
                      <option key={p.profile_id} value={p.profile_id}>
                        {p.profile_name} (Level {p.level}, Index #{p.derivation_index})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Disclosure Tier</label>
                  <select
                    value={selectedTier}
                    onChange={(e) => setSelectedTier(e.target.value)}
                    style={{
                      padding: "0.6rem",
                      borderRadius: "4px",
                      border: "1px solid #ccc",
                      fontSize: "0.9rem",
                    }}
                  >
                    <option value="Tier 0 Inner Circle">
                      Tier 0: Inner Circle (Sanctum)
                    </option>
                    <option value="Tier 0.5 Trusted Alliance">
                      Tier 0.5: Trusted Alliance
                    </option>
                  </select>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1rem",
                  marginBottom: "1rem",
                }}
              >
                <div className="form-group" style={{ margin: 0 }}>
                  <label>Display Name to Disclose</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Alice (Lead Anon)"
                  />
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label>Target Peer DID (Optional)</label>
                  <input
                    type="text"
                    value={targetPeerDid}
                    onChange={(e) => setTargetPeerDid(e.target.value)}
                    placeholder="did:key:z6MkTargetPeer... or blank"
                    list="contacts-list"
                  />
                  <datalist id="contacts-list">
                    {contacts.map((c) => (
                      <option key={c.peer_id} value={c.peer_id}>
                        {c.display_name}
                      </option>
                    ))}
                  </datalist>
                </div>
              </div>

              {/* Personas & Aliases Checkboxes */}
              <div className="form-group" style={{ marginBottom: "1rem" }}>
                <label>
                  Select Identities & Aliases to Include in this Disclosure:
                </label>
                <div
                  style={{
                    background: "#f9fafb",
                    padding: "0.75rem",
                    borderRadius: "6px",
                    border: "1px solid #e5e7eb",
                    maxHeight: "180px",
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                  }}
                >
                  {profiles.map((p) => {
                    const isChecked = selectedPersonaAliases.includes(p.did);
                    return (
                      <label
                        key={p.profile_id}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "0.5rem",
                          fontSize: "0.85rem",
                          cursor: "pointer",
                          padding: "0.3rem",
                          borderRadius: "4px",
                          background: isChecked ? "#ede9fe" : "transparent",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleTogglePersonaAlias(p.did)}
                          style={{ marginTop: "0.2rem" }}
                        />
                        <div>
                          <strong>{p.profile_name}</strong>{" "}
                          <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>
                            (Level {p.level}, #{p.derivation_index})
                          </span>
                          <div
                            style={{
                              fontFamily: "monospace",
                              fontSize: "0.75rem",
                              color: "#4b5563",
                              wordBreak: "break-all",
                            }}
                          >
                            DID: {p.did}
                          </div>
                          {p.nostr_pubkey_hex && (
                            <div
                              style={{
                                fontFamily: "monospace",
                                fontSize: "0.7rem",
                                color: "#6b7280",
                              }}
                            >
                              Nostr Hex: {p.nostr_pubkey_hex.slice(0, 24)}...
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: "1.25rem" }}>
                <label>
                  Email Ownership Claims to Disclose (optional)
                </label>
                <div
                  className="email-ownership-selector"
                  style={{
                    background: "#f9fafb",
                    padding: "0.75rem",
                    borderRadius: "6px",
                    border: "1px solid #e5e7eb",
                    maxHeight: "180px",
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                  }}
                >
                  {emailOptions.length === 0 ? (
                    <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>
                      No EmailOwnershipCredentials stored for this persona.
                    </span>
                  ) : (
                    emailOptions.map((opt) => {
                      const isChecked = selectedEmailVcIds.includes(opt.vc_id);
                      return (
                        <label
                          key={opt.vc_id}
                          data-testid="email-credential-option"
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: "0.5rem",
                            fontSize: "0.85rem",
                            cursor: "pointer",
                            padding: "0.3rem",
                            borderRadius: "4px",
                            background: isChecked ? "#ede9fe" : "transparent",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => handleToggleEmailCredential(opt.vc_id)}
                            style={{ marginTop: "0.2rem" }}
                          />
                          <div>
                            <strong>{opt.email ?? "— email not disclosed —"}</strong>{" "}
                            <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>
                              ({opt.email_type})
                            </span>
                            {opt.verified_at && (
                              <div
                                style={{
                                  fontSize: "0.7rem",
                                  color: "#6b7280",
                                }}
                              >
                                Verified: {opt.verified_at}
                              </div>
                            )}
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
                {targetTrustLevel ? (
                  <p
                    className="muted"
                    style={{ fontSize: "0.75rem", marginTop: "0.35rem" }}
                  >
                    Defaults applied for {String(targetTrustLevel)}. You can toggle
                    any claim before signing.
                  </p>
                ) : (
                  <p
                    className="muted"
                    style={{ fontSize: "0.75rem", marginTop: "0.35rem" }}
                  >
                    Select a known contact to apply trust-tier defaults, or
                    toggle claims manually.
                  </p>
                )}
              </div>

              <div className="form-group" style={{ marginBottom: "1.25rem" }}>
                <label>Additional Custom Aliases / Nostr Pubkeys (optional)</label>
                <textarea
                  value={additionalAliases}
                  onChange={(e) => setAdditionalAliases(e.target.value)}
                  placeholder="one_alias_per_line or comma separated"
                  rows={2}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.75rem",
                }}
              >
                <button
                  type="submit"
                  disabled={isGenerating}
                  style={{
                    padding: "0.6rem 1.25rem",
                    background: "#7c3aed",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {isGenerating ? "Signing Attestation..." : "Generate Signed Card"}
                </button>
              </div>
            </form>

            {/* Generated Output */}
            {generatedCardJson && (
              <div
                style={{
                  marginTop: "1.5rem",
                  padding: "1rem",
                  background: "#f9fafb",
                  borderRadius: "8px",
                  border: "1px solid #e5e7eb",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.5rem",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                  }}
                >
                  <strong style={{ color: "#065f46" }}>
                    ✓ Signed Attestation Card Payload Ready
                  </strong>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={handleDownloadJson}
                      style={{
                        padding: "0.3rem 0.75rem",
                        fontSize: "0.8rem",
                        background: "#f3f4f6",
                        border: "1px solid #d1d5db",
                      }}
                    >
                      💾 Download JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(generatedCardJson)}
                      style={{
                        padding: "0.3rem 0.75rem",
                        fontSize: "0.8rem",
                        background: "#059669",
                        color: "white",
                        border: "none",
                      }}
                    >
                      {copySuccess ? "✓ Copied!" : "📋 Copy Payload"}
                    </button>
                  </div>
                </div>

                <pre
                  className="json-display"
                  style={{ maxHeight: "250px", fontSize: "0.8rem" }}
                >
                  {generatedCardJson}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: IMPORT */}
        {activeTab === "import" && (
          <div>
            <p style={{ fontSize: "0.85rem", color: "#4b5563", marginTop: 0 }}>
              Import and cryptographically verify a Selective Disclosure Card
              payload received from a trusted peer to bind their identities and
              aliases in your Contact Enclave.
            </p>

            {importError && <div className="error-message">{importError}</div>}

            {importSuccess && (
              <div
                style={{
                  background: "#e6f4ea",
                  color: "#137333",
                  padding: "0.85rem 1rem",
                  borderRadius: "6px",
                  marginBottom: "1rem",
                  border: "1px solid #ceead6",
                  fontSize: "0.9rem",
                }}
              >
                <strong>✓ Cryptographic Verification Succeeded!</strong>
                <div style={{ marginTop: "0.3rem" }}>
                  Added peer <strong>{importSuccess.display_name}</strong> (
                  <code>{importSuccess.peer_id.slice(0, 16)}...</code>) with{" "}
                  <strong>{importSuccess.disclosed_aliases.length}</strong>{" "}
                  disclosed aliases.
                </div>
              </div>
            )}

            <form onSubmit={handleImportCard}>
              <div className="form-group">
                <label>Peer's JSON Disclosure Card Payload</label>
                <textarea
                  value={importJsonText}
                  onChange={(e) => setImportJsonText(e.target.value)}
                  placeholder='Paste {"@context": [...], "type": ["VerifiableCredential", ...], "proof": {...}} here...'
                  rows={8}
                  required
                  style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
                />
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.75rem",
                  marginTop: "1rem",
                }}
              >
                <button
                  type="button"
                  onClick={() => setImportJsonText("")}
                  style={{
                    padding: "0.5rem 1rem",
                    background: "#f3f4f6",
                    color: "#374151",
                    border: "1px solid #d1d5db",
                    borderRadius: "6px",
                  }}
                >
                  Clear
                </button>
                <button
                  type="submit"
                  disabled={isImporting}
                  style={{
                    padding: "0.5rem 1.25rem",
                    background: "#7c3aed",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontWeight: 600,
                  }}
                >
                  {isImporting ? "Verifying Signature..." : "Validate & Import Card"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
