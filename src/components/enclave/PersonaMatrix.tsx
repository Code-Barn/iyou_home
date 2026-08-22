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

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Profile } from "../../lib/types";

interface PersonaMatrixProps {
  profiles: Profile[];
  activeDid: string | null;
  onRefresh: () => void | Promise<void>;
}

function truncateString(str: string, lead = 18, tail = 8): string {
  if (!str) return "";
  if (str.length <= lead + tail + 3) return str;
  return `${str.slice(0, lead)}...${str.slice(-tail)}`;
}

export default function PersonaMatrix({
  profiles,
  activeDid,
  onRefresh,
}: PersonaMatrixProps) {
  const [newPersonaName, setNewPersonaName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await writeText(text);
      setCopiedKey(label);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedKey(label);
        setTimeout(() => setCopiedKey(null), 2000);
      } catch (e: any) {
        console.error("Clipboard copy failed:", e);
      }
    }
  };

  const handleSetActive = async (profileId: string) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      await invoke("set_active_profile", { profileId });
      setActionSuccess(`Active persona switched to ${profileId}`);
      await onRefresh();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err: any) {
      setActionError(`Failed to set active profile: ${err.toString()}`);
    }
  };

  const handleCreatePersona = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPersonaName.trim()) return;
    setIsCreating(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      await invoke("add_profile", { profileName: newPersonaName.trim() });
      setNewPersonaName("");
      setActionSuccess("New contextual persona created successfully");
      await onRefresh();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err: any) {
      setActionError(`Failed to create persona: ${err.toString()}`);
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeletePersona = async (profileId: string) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      await invoke("remove_profile", { profileId });
      setDeletingProfileId(null);
      setActionSuccess("Persona removed successfully");
      await onRefresh();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err: any) {
      setActionError(`Failed to delete persona: ${err.toString()}`);
    }
  };

  // Group profiles into the 3 hierarchical tiers
  const anchorProfiles = profiles.filter(
    (p) => p.level === 0 || p.derivation_index === 0 || p.is_system_reserved,
  );
  const primaryProfiles = profiles.filter(
    (p) =>
      (p.level === 1 || p.derivation_index === 1) &&
      !p.is_system_reserved &&
      p.derivation_index !== 0,
  );
  const burnerProfiles = profiles.filter(
    (p) =>
      p.level >= 2 ||
      (p.derivation_index >= 2 &&
        !p.is_system_reserved &&
        p.level !== 0 &&
        p.derivation_index !== 0 &&
        p.derivation_index !== 1),
  );

  return (
    <div className="persona-matrix-container">
      {actionError && <div className="error-message">{actionError}</div>}
      {actionSuccess && (
        <div
          style={{
            background: "#e6f4ea",
            color: "#137333",
            padding: "0.75rem 1rem",
            borderRadius: "6px",
            marginBottom: "1rem",
            border: "1px solid #ceead6",
          }}
        >
          ✓ {actionSuccess}
        </div>
      )}

      {/* Level 0: Anchor Sanctum */}
      <div
        className="section"
        style={{
          borderLeft: "4px solid #7c3aed",
          background: "rgba(124, 58, 237, 0.04)",
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
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.3rem" }}>🛡️🔒</span>
            <h3 style={{ margin: 0, color: "#7c3aed" }}>
              Level 0 — Anchor Sanctum (Air-Gapped Root)
            </h3>
          </div>
          <span
            style={{
              background: "#ede9fe",
              color: "#6d28d9",
              padding: "0.2rem 0.6rem",
              borderRadius: "12px",
              fontSize: "0.75rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              border: "1px solid #ddd6fe",
            }}
          >
            System Reserved • Zero Exposure
          </span>
        </div>

        <div
          style={{
            background: "#fef3c7",
            color: "#92400e",
            padding: "0.6rem 0.85rem",
            borderRadius: "6px",
            margin: "0.75rem 0",
            fontSize: "0.85rem",
            border: "1px solid #fde68a",
            lineHeight: "1.4",
          }}
        >
          ⚠️ <strong>Air-Gap Guarantee:</strong> This root anchor identity is
          permanently air-gapped from public feeds, satellite apps, and external
          signing pickers. It is strictly reserved for inner-circle P2P attestations
          and high-assurance identity containment.
        </div>

        {anchorProfiles.map((p) => (
          <div
            key={p.profile_id}
            style={{
              padding: "0.85rem",
              borderRadius: "8px",
              background: "white",
              border: "1px solid #e5e7eb",
              marginTop: "0.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "0.5rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <strong>{p.profile_name}</strong>
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "#6b7280",
                    background: "#f3f4f6",
                    padding: "0.1rem 0.4rem",
                    borderRadius: "4px",
                  }}
                >
                  Derivation Index: #{p.derivation_index}
                </span>
              </div>
              <span style={{ fontSize: "0.8rem", color: "#6d28d9", fontWeight: 600 }}>
                🔒 Locked Anchor
              </span>
            </div>

            <div style={{ fontSize: "0.85rem", margin: "0.4rem 0" }}>
              <div style={{ color: "#4b5563", marginBottom: "0.2rem" }}>
                Anchor DID:
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  background: "#f9fafb",
                  padding: "0.4rem 0.6rem",
                  borderRadius: "4px",
                  border: "1px solid #e5e7eb",
                  fontFamily: "monospace",
                  wordBreak: "break-all",
                }}
              >
                <span>{p.did}</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(p.did, `anchor-did-${p.profile_id}`)}
                  style={{
                    padding: "0.2rem 0.5rem",
                    fontSize: "0.75rem",
                    marginLeft: "0.5rem",
                    whiteSpace: "nowrap",
                  }}
                >
                  {copiedKey === `anchor-did-${p.profile_id}` ? "✓ Copied" : "📋 Copy"}
                </button>
              </div>
            </div>

            {p.nostr_pubkey_hex && (
              <div style={{ fontSize: "0.85rem", margin: "0.4rem 0" }}>
                <div style={{ color: "#4b5563", marginBottom: "0.2rem" }}>
                  Anchor Nostr Hex:
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    background: "#f9fafb",
                    padding: "0.4rem 0.6rem",
                    borderRadius: "4px",
                    border: "1px solid #e5e7eb",
                    fontFamily: "monospace",
                    wordBreak: "break-all",
                  }}
                >
                  <span>{truncateString(p.nostr_pubkey_hex, 20, 12)}</span>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(
                        p.nostr_pubkey_hex!,
                        `anchor-hex-${p.profile_id}`,
                      )
                    }
                    style={{
                      padding: "0.2rem 0.5rem",
                      fontSize: "0.75rem",
                      marginLeft: "0.5rem",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {copiedKey === `anchor-hex-${p.profile_id}` ? "✓ Copied" : "📋 Copy"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Level 1: Public Persona */}
      <div
        className="section"
        style={{
          borderLeft: "4px solid #2563eb",
          background: "rgba(37, 99, 235, 0.03)",
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
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.3rem" }}>👤</span>
            <h3 style={{ margin: 0, color: "#2563eb" }}>
              Level 1 — Primary Identity (Public Persona)
            </h3>
          </div>
          <span
            style={{
              background: "#dbeafe",
              color: "#1d4ed8",
              padding: "0.2rem 0.6rem",
              borderRadius: "12px",
              fontSize: "0.75rem",
              fontWeight: 700,
              border: "1px solid #bfdbfe",
            }}
          >
            Public Social Identity
          </span>
        </div>

        <p style={{ fontSize: "0.85rem", color: "#4b5563", margin: "0.5rem 0 1rem" }}>
          Default sovereign persona used for standard Nostr social broadcasting,
          Verifiable Credentials, and public signing requests.
        </p>

        {primaryProfiles.map((p) => {
          const isActive = p.did === activeDid;
          return (
            <div
              key={p.profile_id}
              style={{
                padding: "0.85rem",
                borderRadius: "8px",
                background: isActive ? "#eff6ff" : "white",
                border: isActive ? "1px solid #3b82f6" : "1px solid #e5e7eb",
                marginTop: "0.5rem",
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
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <strong style={{ fontSize: "0.95rem" }}>{p.profile_name}</strong>
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "#6b7280",
                      background: "#f3f4f6",
                      padding: "0.1rem 0.4rem",
                      borderRadius: "4px",
                    }}
                  >
                    Index #{p.derivation_index}
                  </span>
                  {isActive && (
                    <span
                      style={{
                        background: "#10b981",
                        color: "white",
                        padding: "0.1rem 0.5rem",
                        borderRadius: "10px",
                        fontSize: "0.7rem",
                        fontWeight: 600,
                      }}
                    >
                      Active Persona
                    </span>
                  )}
                </div>

                {!isActive && (
                  <button
                    type="button"
                    onClick={() => handleSetActive(p.profile_id)}
                    style={{
                      padding: "0.3rem 0.75rem",
                      fontSize: "0.8rem",
                      background: "#2563eb",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                    }}
                  >
                    Set as Active
                  </button>
                )}
              </div>

              <div style={{ fontSize: "0.85rem", margin: "0.4rem 0" }}>
                <div style={{ color: "#4b5563", marginBottom: "0.2rem" }}>DID:</div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    background: "#f9fafb",
                    padding: "0.4rem 0.6rem",
                    borderRadius: "4px",
                    border: "1px solid #e5e7eb",
                    fontFamily: "monospace",
                    wordBreak: "break-all",
                  }}
                >
                  <span>{p.did}</span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(p.did, `primary-did-${p.profile_id}`)}
                    style={{
                      padding: "0.2rem 0.5rem",
                      fontSize: "0.75rem",
                      marginLeft: "0.5rem",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {copiedKey === `primary-did-${p.profile_id}`
                      ? "✓ Copied"
                      : "📋 Copy"}
                  </button>
                </div>
              </div>

              {p.nostr_pubkey_hex && (
                <div style={{ fontSize: "0.85rem", margin: "0.4rem 0" }}>
                  <div style={{ color: "#4b5563", marginBottom: "0.2rem" }}>
                    Nostr Pubkey Hex:
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background: "#f9fafb",
                      padding: "0.4rem 0.6rem",
                      borderRadius: "4px",
                      border: "1px solid #e5e7eb",
                      fontFamily: "monospace",
                      wordBreak: "break-all",
                    }}
                  >
                    <span>{truncateString(p.nostr_pubkey_hex, 24, 12)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        copyToClipboard(
                          p.nostr_pubkey_hex!,
                          `primary-hex-${p.profile_id}`,
                        )
                      }
                      style={{
                        padding: "0.2rem 0.5rem",
                        fontSize: "0.75rem",
                        marginLeft: "0.5rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {copiedKey === `primary-hex-${p.profile_id}`
                        ? "✓ Copied"
                        : "📋 Copy"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Level 2+: Contextual / Burner Personas */}
      <div
        className="section"
        style={{
          borderLeft: "4px solid #059669",
          background: "rgba(5, 150, 105, 0.03)",
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
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.3rem" }}>🎭🔥</span>
            <h3 style={{ margin: 0, color: "#059669" }}>
              Level 2+ — Contextual / Burner Identities ({burnerProfiles.length})
            </h3>
          </div>
          <span
            style={{
              background: "#d1fae5",
              color: "#065f46",
              padding: "0.2rem 0.6rem",
              borderRadius: "12px",
              fontSize: "0.75rem",
              fontWeight: 700,
              border: "1px solid #a7f3d0",
            }}
          >
            Disposable Pseudonyms
          </span>
        </div>

        <p style={{ fontSize: "0.85rem", color: "#4b5563", margin: "0.5rem 0 1rem" }}>
          Contextual burner personas isolate distinct communities, sensitive
          topics, and P2P sockets without leaking your primary identity.
        </p>

        {/* Add Burner Form */}
        <form
          onSubmit={handleCreatePersona}
          style={{
            display: "flex",
            gap: "0.5rem",
            marginBottom: "1rem",
            flexWrap: "wrap",
          }}
        >
          <input
            type="text"
            value={newPersonaName}
            onChange={(e) => setNewPersonaName(e.target.value)}
            placeholder="e.g. 'Project Beta Anon', 'DAO Voting Sock'"
            required
            style={{
              flex: "1 1 250px",
              padding: "0.5rem 0.75rem",
              borderRadius: "6px",
              border: "1px solid #d1d5db",
              fontSize: "0.9rem",
            }}
          />
          <button
            type="submit"
            disabled={isCreating}
            style={{
              padding: "0.5rem 1rem",
              background: "#059669",
              color: "white",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              fontSize: "0.9rem",
              cursor: "pointer",
            }}
          >
            {isCreating ? "Creating..." : "+ Create Persona"}
          </button>
        </form>

        {burnerProfiles.length === 0 ? (
          <div
            style={{
              padding: "1.5rem",
              textAlign: "center",
              background: "white",
              borderRadius: "8px",
              border: "1px dashed #d1d5db",
              color: "#6b7280",
            }}
          >
            <p style={{ margin: 0, fontWeight: 500 }}>
              No contextual burner personas created yet.
            </p>
            <small>
              Create disposable personas above to participate under independent
              identities.
            </small>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {burnerProfiles.map((p) => {
              const isActive = p.did === activeDid;
              return (
                <div
                  key={p.profile_id}
                  style={{
                    padding: "0.85rem",
                    borderRadius: "8px",
                    background: isActive ? "#f0fdf4" : "white",
                    border: isActive ? "1px solid #10b981" : "1px solid #e5e7eb",
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
                    <div
                      style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                    >
                      <strong style={{ fontSize: "0.95rem" }}>
                        {p.profile_name}
                      </strong>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          color: "#6b7280",
                          background: "#f3f4f6",
                          padding: "0.1rem 0.4rem",
                          borderRadius: "4px",
                        }}
                      >
                        Index #{p.derivation_index}
                      </span>
                      {isActive && (
                        <span
                          style={{
                            background: "#10b981",
                            color: "white",
                            padding: "0.1rem 0.5rem",
                            borderRadius: "10px",
                            fontSize: "0.7rem",
                            fontWeight: 600,
                          }}
                        >
                          Active
                        </span>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => handleSetActive(p.profile_id)}
                          style={{
                            padding: "0.25rem 0.6rem",
                            fontSize: "0.75rem",
                            background: "#10b981",
                            color: "white",
                            border: "none",
                            borderRadius: "4px",
                          }}
                        >
                          Set Active
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setDeletingProfileId(p.profile_id)}
                        style={{
                          padding: "0.25rem 0.6rem",
                          fontSize: "0.75rem",
                          background: "#fee2e2",
                          color: "#b91c1c",
                          border: "1px solid #fecaca",
                          borderRadius: "4px",
                        }}
                      >
                        🗑️ Delete
                      </button>
                    </div>
                  </div>

                  <div style={{ fontSize: "0.85rem", margin: "0.4rem 0" }}>
                    <div style={{ color: "#4b5563", marginBottom: "0.2rem" }}>
                      DID:
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        background: "#f9fafb",
                        padding: "0.4rem 0.6rem",
                        borderRadius: "4px",
                        border: "1px solid #e5e7eb",
                        fontFamily: "monospace",
                        wordBreak: "break-all",
                      }}
                    >
                      <span>{p.did}</span>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(p.did, `burner-did-${p.profile_id}`)
                        }
                        style={{
                          padding: "0.2rem 0.5rem",
                          fontSize: "0.75rem",
                          marginLeft: "0.5rem",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {copiedKey === `burner-did-${p.profile_id}`
                          ? "✓ Copied"
                          : "📋 Copy"}
                      </button>
                    </div>
                  </div>

                  {p.nostr_pubkey_hex && (
                    <div style={{ fontSize: "0.85rem", margin: "0.4rem 0" }}>
                      <div style={{ color: "#4b5563", marginBottom: "0.2rem" }}>
                        Nostr Pubkey Hex:
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          background: "#f9fafb",
                          padding: "0.4rem 0.6rem",
                          borderRadius: "4px",
                          border: "1px solid #e5e7eb",
                          fontFamily: "monospace",
                          wordBreak: "break-all",
                        }}
                      >
                        <span>{truncateString(p.nostr_pubkey_hex, 24, 12)}</span>
                        <button
                          type="button"
                          onClick={() =>
                            copyToClipboard(
                              p.nostr_pubkey_hex!,
                              `burner-hex-${p.profile_id}`,
                            )
                          }
                          style={{
                            padding: "0.2rem 0.5rem",
                            fontSize: "0.75rem",
                            marginLeft: "0.5rem",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {copiedKey === `burner-hex-${p.profile_id}`
                            ? "✓ Copied"
                            : "📋 Copy"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deletingProfileId && (
        <div className="modal-overlay" onClick={() => setDeletingProfileId(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, color: "#dc2626" }}>Delete Persona</h3>
            <p>
              Are you sure you want to delete persona{" "}
              <strong>{deletingProfileId}</strong>? All associated credentials and
              signing keys derived for this index will be permanently removed.
            </p>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                justifyContent: "flex-end",
                marginTop: "1.5rem",
              }}
            >
              <button
                type="button"
                onClick={() => setDeletingProfileId(null)}
                style={{
                  padding: "0.5rem 1rem",
                  background: "#f3f4f6",
                  color: "#374151",
                  border: "1px solid #d1d5db",
                  borderRadius: "6px",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDeletePersona(deletingProfileId)}
                style={{
                  padding: "0.5rem 1rem",
                  background: "#dc2626",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                }}
              >
                Delete Persona
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
