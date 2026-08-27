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

import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { PeerContact, TrustLevel } from "../../lib/types";

interface ContactListProps {
  contacts: PeerContact[];
  onRefresh: () => void | Promise<void>;
  onOpenDisclosure: () => void;
}

function isInnerCircle(trustLevel: TrustLevel | string): boolean {
  const norm = String(trustLevel || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return norm === "level0" || norm.includes("inner");
}

function truncateString(str: string, lead = 16, tail = 8): string {
  if (!str) return "";
  if (str.length <= lead + tail + 3) return str;
  return `${str.slice(0, lead)}...${str.slice(-tail)}`;
}

function getTrustBadgeInfo(trustLevel: TrustLevel | string): {
  label: string;
  badgeStyle: React.CSSProperties;
} {
  const norm = String(trustLevel || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  if (norm.includes("05") || norm.includes("alliance")) {
    return {
      label: "Trusted Alliance",
      badgeStyle: {
        background: "#d1fae5",
        color: "#065f46",
        border: "1px solid #6ee7b7",
      },
    };
  }
  if (norm.includes("0") || norm.includes("inner")) {
    return {
      label: "Inner Circle",
      badgeStyle: {
        background: "#f3e8ff",
        color: "#6b21a8",
        border: "1px solid #d8b4fe",
      },
    };
  }
  return {
    label: "Peer",
    badgeStyle: {
      background: "#f1f5f9",
      color: "#334155",
      border: "1px solid #cbd5e1",
    },
  };
}

export default function ContactList({
  contacts,
  onRefresh,
  onOpenDisclosure,
}: ContactListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showUpsertModal, setShowUpsertModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Form State
  const [formPeerId, setFormPeerId] = useState("");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formTrustLevel, setFormTrustLevel] = useState<TrustLevel>("level1");
  const [formAliasesText, setFormAliasesText] = useState("");
  const [formReceipt, setFormReceipt] = useState<string | undefined>(undefined);

  const [deleteConfirmPeerId, setDeleteConfirmPeerId] = useState<string | null>(
    null,
  );
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Masking & Reveal State (Level 0 peers only)
  const [revealedPeers, setRevealedPeers] = useState<Set<string>>(new Set());
  const [pendingCopyContact, setPendingCopyContact] = useState<PeerContact | null>(null);

  const formatMaskedKey = (key: string): string => {
    if (!key) return "";
    if (key.startsWith("did:")) {
      return `${key.slice(0, 12)}••••••••••••••••••••••••••••••••${key.slice(-4)}`;
    }
    return `${key.slice(0, 8)}••••••••••••••••••••••••••••••••${key.slice(-4)}`;
  };

  const togglePeerReveal = (peerId: string) => {
    setRevealedPeers((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  };

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
      } catch (e) {
        console.error("Copy failed", e);
      }
    }
  };

  const handleOpenAdd = () => {
    setIsEditing(false);
    setFormPeerId("");
    setFormDisplayName("");
    setFormTrustLevel("level1");
    setFormAliasesText("");
    setFormReceipt(undefined);
    setActionError(null);
    setShowUpsertModal(true);
  };

  const handleOpenEdit = (contact: PeerContact) => {
    setIsEditing(true);
    setFormPeerId(contact.peer_id);
    setFormDisplayName(contact.display_name);
    setFormTrustLevel(contact.trust_level);
    setFormAliasesText(contact.disclosed_aliases.join("\n"));
    setFormReceipt(contact.attestation_receipt);
    setActionError(null);
    setShowUpsertModal(true);
  };

  const handleSaveContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formPeerId.trim()) {
      setActionError("Peer ID (DID or Nostr Pubkey) is required");
      return;
    }
    setIsSubmitting(true);
    setActionError(null);
    setActionSuccess(null);

    const aliases = formAliasesText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const contactPayload: PeerContact = {
      peer_id: formPeerId.trim(),
      display_name: formDisplayName.trim() || "Unnamed Peer",
      trust_level: formTrustLevel,
      disclosed_aliases: aliases,
      attestation_receipt: formReceipt,
      created_at: 0,
      updated_at: 0,
    };

    try {
      await invoke("upsert_contact", { contact: contactPayload });
      setShowUpsertModal(false);
      setActionSuccess(
        isEditing
          ? `Contact '${contactPayload.display_name}' updated`
          : `Contact '${contactPayload.display_name}' added`,
      );
      await onRefresh();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err: any) {
      setActionError(`Failed to save contact: ${err.toString()}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteContact = async (peerId: string) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      await invoke("delete_contact", { peerId });
      setDeleteConfirmPeerId(null);
      setActionSuccess("Contact deleted successfully");
      await onRefresh();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err: any) {
      setActionError(`Failed to delete contact: ${err.toString()}`);
    }
  };

  const filteredContacts = contacts.filter((c) => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      c.display_name.toLowerCase().includes(q) ||
      c.peer_id.toLowerCase().includes(q) ||
      c.disclosed_aliases.some((a) => a.toLowerCase().includes(q))
    );
  });

  return (
    <div className="contact-enclave-container">
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

      {/* Action Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.75rem",
          marginBottom: "1.25rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <h3 style={{ margin: 0 }}>Peer Contacts ({contacts.length})</h3>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onOpenDisclosure}
            style={{
              padding: "0.5rem 0.9rem",
              background: "#7c3aed",
              color: "white",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              fontSize: "0.85rem",
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            🪪 Selective Disclosure Cards
          </button>
          <button
            type="button"
            onClick={handleOpenAdd}
            style={{
              padding: "0.5rem 0.9rem",
              background: "#2563eb",
              color: "white",
              border: "none",
              borderRadius: "6px",
              fontWeight: 600,
              fontSize: "0.85rem",
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            + Add Contact
          </button>
        </div>
      </div>

      {/* Search Filter */}
      {contacts.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, DID, or alias..."
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              borderRadius: "6px",
              border: "1px solid #d1d5db",
              fontSize: "0.9rem",
            }}
          />
        </div>
      )}

      {/* Level 0 Routing Micro-copy */}
      {contacts.some((c) => isInnerCircle(c.trust_level)) && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "6px",
            fontSize: "0.78rem",
            color: "#1e40af",
            marginBottom: "1rem",
            lineHeight: 1.45,
          }}
        >
          Inner Circle (Level 0) peer keys are masked by default and require
          confirmation to copy. Live communications route through your{" "}
          <strong>Level 1 persona</strong>.
        </div>
      )}

      {contacts.length === 0 ? (
        <div
          style={{
            padding: "2.5rem 1.5rem",
            textAlign: "center",
            background: "#f9fafb",
            borderRadius: "8px",
            border: "1px dashed #d1d5db",
            color: "#6b7280",
          }}
        >
          <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.5rem" }}>
            👥
          </span>
          <h4 style={{ margin: "0 0 0.5rem", color: "#374151" }}>
            Contact Enclave is Empty
          </h4>
          <p style={{ margin: "0 0 1rem", fontSize: "0.9rem" }}>
            Add trusted peer contacts manually or import signed Selective Disclosure
            Cards from your network peers.
          </p>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
            <button
              type="button"
              onClick={handleOpenAdd}
              style={{
                padding: "0.5rem 1rem",
                background: "#2563eb",
                color: "white",
                border: "none",
                borderRadius: "6px",
                fontSize: "0.85rem",
              }}
            >
              + Add Peer Contact
            </button>
            <button
              type="button"
              onClick={onOpenDisclosure}
              style={{
                padding: "0.5rem 1rem",
                background: "#7c3aed",
                color: "white",
                border: "none",
                borderRadius: "6px",
                fontSize: "0.85rem",
              }}
            >
              Import Disclosure Card
            </button>
          </div>
        </div>
      ) : filteredContacts.length === 0 ? (
        <div style={{ padding: "1.5rem", textAlign: "center", color: "#6b7280" }}>
          No contacts match "{searchQuery}".
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {filteredContacts.map((contact) => {
            const badge = getTrustBadgeInfo(contact.trust_level);
            return (
              <div
                key={contact.peer_id}
                style={{
                  padding: "1rem",
                  borderRadius: "8px",
                  background: "white",
                  border: "1px solid #e5e7eb",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                }}
              >
                {/* Header row */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                    marginBottom: "0.6rem",
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        flexWrap: "wrap",
                      }}
                    >
                      <strong style={{ fontSize: "1.05rem" }}>
                        {contact.display_name}
                      </strong>
                      <span
                        style={{
                          padding: "0.15rem 0.6rem",
                          borderRadius: "12px",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          ...badge.badgeStyle,
                        }}
                      >
                        {badge.label}
                      </span>
                      {contact.attestation_receipt && (
                        <button
                          type="button"
                          onClick={() =>
                            setViewingReceipt(contact.attestation_receipt!)
                          }
                          style={{
                            padding: "0.1rem 0.5rem",
                            borderRadius: "10px",
                            fontSize: "0.7rem",
                            background: "#ede9fe",
                            color: "#6d28d9",
                            border: "1px solid #ddd6fe",
                            cursor: "pointer",
                          }}
                          title="View Cryptographic Attestation Receipt"
                        >
                          📜 Verified Attestation
                        </button>
                      )}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        marginTop: "0.3rem",
                        fontFamily: "monospace",
                        fontSize: "0.8rem",
                        color: "#4b5563",
                      }}
                    >
                      <span title={isInnerCircle(contact.trust_level) && !revealedPeers.has(contact.peer_id) ? "Hidden — click 🙈 to reveal" : contact.peer_id}>
                        {isInnerCircle(contact.trust_level) && !revealedPeers.has(contact.peer_id)
                          ? formatMaskedKey(contact.peer_id)
                          : truncateString(contact.peer_id, 24, 10)}
                      </span>
                      {isInnerCircle(contact.trust_level) && (
                        <button
                          type="button"
                          onClick={() => togglePeerReveal(contact.peer_id)}
                          style={{
                            padding: "0.1rem 0.4rem",
                            fontSize: "0.7rem",
                          }}
                          title={revealedPeers.has(contact.peer_id) ? "Hide peer key" : "Reveal peer key"}
                        >
                          {revealedPeers.has(contact.peer_id) ? "🙈" : "👁️"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (isInnerCircle(contact.trust_level)) {
                            setPendingCopyContact(contact);
                          } else {
                            copyToClipboard(
                              contact.peer_id,
                              `peer-id-${contact.peer_id}`,
                            );
                          }
                        }}
                        style={{
                          padding: "0.1rem 0.4rem",
                          fontSize: "0.7rem",
                        }}
                      >
                        {copiedKey === `peer-id-${contact.peer_id}`
                          ? "✓"
                          : "📋"}
                      </button>
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", gap: "0.4rem" }}>
                    <button
                      type="button"
                      onClick={() => handleOpenEdit(contact)}
                      style={{
                        padding: "0.25rem 0.6rem",
                        fontSize: "0.75rem",
                        background: "#f3f4f6",
                        color: "#374151",
                        border: "1px solid #d1d5db",
                        borderRadius: "4px",
                      }}
                    >
                      ✏️ Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmPeerId(contact.peer_id)}
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

                {/* Disclosed Aliases Pills */}
                <div style={{ marginTop: "0.5rem" }}>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "#6b7280",
                      fontWeight: 600,
                      marginBottom: "0.3rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                    }}
                  >
                    Disclosed Aliases & Sockets (
                    {contact.disclosed_aliases.length}):
                  </div>
                  {contact.disclosed_aliases.length === 0 ? (
                    <span
                      style={{
                        fontSize: "0.8rem",
                        color: "#9ca3af",
                        fontStyle: "italic",
                      }}
                    >
                      No aliases disclosed.
                    </span>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "0.4rem",
                      }}
                    >
                      {contact.disclosed_aliases.map((alias, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.3rem",
                            background: "#f3f4f6",
                            padding: "0.2rem 0.5rem",
                            borderRadius: "12px",
                            fontSize: "0.75rem",
                            fontFamily: "monospace",
                            border: "1px solid #e5e7eb",
                            color: "#374151",
                          }}
                        >
                          <span title={alias}>
                            {truncateString(alias, 12, 6)}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              copyToClipboard(
                                alias,
                                `alias-${contact.peer_id}-${idx}`,
                              )
                            }
                            style={{
                              padding: "0.05rem 0.25rem",
                              fontSize: "0.65rem",
                              background: "none",
                              boxShadow: "none",
                              border: "none",
                              cursor: "pointer",
                            }}
                            title="Copy alias"
                          >
                            {copiedKey === `alias-${contact.peer_id}-${idx}`
                              ? "✓"
                              : "📋"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Upsert Contact Modal */}
      {showUpsertModal && (
        <div
          className="modal-overlay"
          onClick={() => setShowUpsertModal(false)}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "550px" }}
          >
            <h3 style={{ marginTop: 0 }}>
              {isEditing ? "Edit Peer Contact" : "Add Trusted Peer Contact"}
            </h3>

            <form onSubmit={handleSaveContact}>
              <div className="form-group">
                <label>Peer Canonical ID (DID or Nostr Pubkey Hex) *</label>
                <input
                  type="text"
                  value={formPeerId}
                  onChange={(e) => setFormPeerId(e.target.value)}
                  placeholder="did:key:z6Mk... or 64-char hex Nostr pubkey"
                  required
                  disabled={isEditing}
                />
              </div>

              <div className="form-group">
                <label>Display Name / Nickname *</label>
                <input
                  type="text"
                  value={formDisplayName}
                  onChange={(e) => setFormDisplayName(e.target.value)}
                  placeholder='e.g. "Alice (Security Lead)"'
                  required
                />
              </div>

              <div className="form-group">
                <label>Trust Level Badge</label>
                <select
                  value={formTrustLevel}
                  onChange={(e) =>
                    setFormTrustLevel(e.target.value as TrustLevel)
                  }
                  style={{
                    padding: "0.6rem",
                    borderRadius: "4px",
                    border: "1px solid #ccc",
                    fontSize: "0.9rem",
                  }}
                >
                  <option value="level0">Level 0: Inner Circle (Sanctum Peer)</option>
                  <option value="level0_5">
                    Level 0.5: Trusted Alliance (Vouched Collaborator)
                  </option>
                  <option value="level1">Level 1: Peer (Standard Contact)</option>
                </select>
              </div>

              <div className="form-group">
                <label>Disclosed Aliases / Sockets (one per line or comma)</label>
                <textarea
                  value={formAliasesText}
                  onChange={(e) => setFormAliasesText(e.target.value)}
                  placeholder="did:key:z6MkBurnerSock...&#10;hex_nostr_pubkey_alias..."
                  rows={3}
                />
              </div>

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
                  onClick={() => setShowUpsertModal(false)}
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
                  type="submit"
                  disabled={isSubmitting}
                  style={{
                    padding: "0.5rem 1rem",
                    background: "#2563eb",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontWeight: 600,
                  }}
                >
                  {isSubmitting ? "Saving..." : isEditing ? "Update Contact" : "Add Contact"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmPeerId && (
        <div
          className="modal-overlay"
          onClick={() => setDeleteConfirmPeerId(null)}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, color: "#dc2626" }}>Delete Contact</h3>
            <p>
              Are you sure you want to delete peer contact{" "}
              <code>{truncateString(deleteConfirmPeerId, 16, 8)}</code>? Any linked
              alias resolution entries will be removed from local store.
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
                onClick={() => setDeleteConfirmPeerId(null)}
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
                onClick={() => handleDeleteContact(deleteConfirmPeerId)}
                style={{
                  padding: "0.5rem 1rem",
                  background: "#dc2626",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                }}
              >
                Delete Contact
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View Attestation Receipt Modal */}
      {viewingReceipt && (
        <div
          className="modal-overlay"
          onClick={() => setViewingReceipt(null)}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "650px" }}
          >
            <h3 style={{ marginTop: 0 }}>
              📜 Verified Cryptographic Attestation
            </h3>
            <p style={{ fontSize: "0.85rem", color: "#4b5563" }}>
              Raw cryptographic payload received and verified when importing this
              peer's Selective Disclosure Card:
            </p>
            <pre className="json-display" style={{ maxHeight: "350px" }}>
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(viewingReceipt), null, 2);
                } catch {
                  return viewingReceipt;
                }
              })()}
            </pre>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: "1rem",
              }}
            >
              <button
                type="button"
                onClick={() => copyToClipboard(viewingReceipt, "receipt-raw")}
              >
                {copiedKey === "receipt-raw" ? "✓ Copied Payload" : "📋 Copy JSON"}
              </button>
              <button type="button" onClick={() => setViewingReceipt(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Level 0 Peer Key Copy Confirmation Modal */}
      {pendingCopyContact && (
        <div
          className="modal-overlay"
          onClick={() => setPendingCopyContact(null)}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "480px",
              border: "1px solid #fecaca",
              boxShadow: "0 4px 24px rgba(220,38,38,0.12)",
            }}
          >
            <h3 style={{ marginTop: 0, color: "#dc2626" }}>
              ⚠️ Copy Inner Circle Key
            </h3>
            <p style={{ fontSize: "0.9rem", color: "#374151", lineHeight: 1.5 }}>
              You are about to copy the <strong>Level 0 (Inner Circle)</strong> peer
              identifier for{" "}
              <strong>{pendingCopyContact.display_name}</strong>:
            </p>
            <pre
              style={{
                background: "#fef2f2",
                padding: "0.75rem",
                borderRadius: "6px",
                fontSize: "0.8rem",
                fontFamily: "monospace",
                wordBreak: "break-all",
                border: "1px solid #fecaca",
                color: "#991b1b",
              }}
            >
              {pendingCopyContact.peer_id}
            </pre>
            <div
              style={{
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: "6px",
                padding: "0.75rem",
                marginBottom: "1rem",
                fontSize: "0.8rem",
                color: "#92400e",
                lineHeight: 1.5,
              }}
            >
              This is an Inner Circle key. Handle with care — do not paste into
              group chats, public channels, or untrusted applications.
            </div>
            <div
              style={{
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                borderRadius: "6px",
                padding: "0.75rem",
                marginBottom: "1rem",
                fontSize: "0.8rem",
                color: "#1e40af",
                lineHeight: 1.5,
              }}
            >
              <strong>Note:</strong> Live communications with this peer always route
              through your <strong>Level 1 persona</strong> — this Inner Circle key
              is for out-of-band verification only.
            </div>
            <div
              style={{
                display: "flex",
                gap: "0.75rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={() => setPendingCopyContact(null)}
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
                onClick={async () => {
                  const contact = pendingCopyContact;
                  setPendingCopyContact(null);
                  if (contact) {
                    await copyToClipboard(
                      contact.peer_id,
                      `peer-id-${contact.peer_id}`,
                    );
                  }
                }}
                style={{
                  padding: "0.5rem 1rem",
                  background: "#dc2626",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                }}
              >
                Copy Key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
