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

import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface QuickDispatchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type DispatchTab = "note" | "media" | "poll";

const RELAY_ENDPOINTS = [
  "ws://127.0.0.1:9003",
  "wss://relay.iyou.me",
  "wss://nos.lol",
];

async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function broadcastToRelays(event: any): void {
  for (const relayUrl of RELAY_ENDPOINTS) {
    try {
      const ws = new WebSocket(relayUrl);
      ws.onopen = () => {
        ws.send(JSON.stringify(["EVENT", event]));
        setTimeout(() => {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }, 1500);
      };
      ws.onerror = () => {
        // Best-effort external relay delivery
      };
    } catch {
      // Best-effort
    }
  }
}

export default function QuickDispatchModal({ isOpen, onClose }: QuickDispatchModalProps) {
  const [tab, setTab] = useState<DispatchTab>("note");
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Note State (Kind 1)
  const [noteContent, setNoteContent] = useState("");

  // Media State (Kind 1063)
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaAlt, setMediaAlt] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Civic Poll State (Kind 30023)
  const [pollTitle, setPollTitle] = useState("");
  const [pollDescription, setPollDescription] = useState("");
  const [pollOptions, setPollOptions] = useState<string[]>(["Option 1", "Option 2"]);
  const [minFidelity, setMinFidelity] = useState("social");
  const [durationHours, setDurationHours] = useState(24);

  if (!isOpen) return null;

  const handleAddOption = () => {
    if (pollOptions.length < 8) {
      setPollOptions([...pollOptions, `Option ${pollOptions.length + 1}`]);
    }
  };

  const handleRemoveOption = (index: number) => {
    if (pollOptions.length > 2) {
      setPollOptions(pollOptions.filter((_, i) => i !== index));
    }
  };

  const handleOptionChange = (index: number, val: string) => {
    const updated = [...pollOptions];
    updated[index] = val;
    setPollOptions(updated);
  };

  const handleDispatchNote = async () => {
    if (!noteContent.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const signedEvent = await invoke<any>("dispatch_nostr_event", {
        kind: 1,
        content: noteContent.trim(),
        tags: [],
      });

      broadcastToRelays(signedEvent);
      const shortId = signedEvent?.id ? signedEvent.id.slice(0, 8) : "ok";
      setStatusMessage(`✅ Event published to mesh (ID: ${shortId}...)`);
      setNoteContent("");
      setTimeout(() => {
        onClose();
        setStatusMessage(null);
      }, 1200);
    } catch (err: any) {
      setErrorMessage(`Dispatch failed: ${err.toString()}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDispatchMedia = async () => {
    if (!selectedFile) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const fileBytes = await selectedFile.arrayBuffer();
      const sha256 = await computeSha256Hex(fileBytes);

      // Upload raw binary to local Blossom Personal Data Store
      try {
        await fetch(`http://127.0.0.1:9002/${sha256}`, {
          method: "PUT",
          headers: {
            "Content-Type": selectedFile.type || "application/octet-stream",
          },
          body: fileBytes,
        });
      } catch {
        // Blossom local daemon might be offline; continue to sign event
      }

      const tags = [
        ["url", `http://127.0.0.1:9002/${sha256}`],
        ["x", sha256],
        ["m", selectedFile.type || "application/octet-stream"],
        ["size", String(selectedFile.size)],
        ["alt", mediaAlt.trim() || selectedFile.name],
      ];

      const signedEvent = await invoke<any>("dispatch_nostr_event", {
        kind: 1063,
        content: mediaAlt.trim() || selectedFile.name,
        tags,
      });

      broadcastToRelays(signedEvent);
      const shortId = signedEvent?.id ? signedEvent.id.slice(0, 8) : "ok";
      setStatusMessage(`✅ Media drop published to mesh (ID: ${shortId}...)`);
      setSelectedFile(null);
      setMediaAlt("");
      setTimeout(() => {
        onClose();
        setStatusMessage(null);
      }, 1200);
    } catch (err: any) {
      setErrorMessage(`Media upload failed: ${err.toString()}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDispatchPoll = async () => {
    if (!pollTitle.trim() || pollOptions.some((opt) => !opt.trim())) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const pollId = `poll-${Date.now()}`;
      const expiresTs = Math.floor(Date.now() / 1000) + durationHours * 3600;

      const tags: string[][] = [
        ["d", pollId],
        ["title", pollTitle.trim()],
        ["fidelity_min", minFidelity.toLowerCase()],
        ["expires", String(expiresTs)],
        ["alt", `Civic Poll: ${pollTitle.trim()}`],
      ];

      pollOptions.forEach((opt, idx) => {
        tags.push(["option", String(idx + 1), opt.trim()]);
      });

      const signedEvent = await invoke<any>("dispatch_nostr_event", {
        kind: 30023,
        content: pollDescription.trim(),
        tags,
      });

      broadcastToRelays(signedEvent);
      const shortId = signedEvent?.id ? signedEvent.id.slice(0, 8) : "ok";
      setStatusMessage(`✅ Civic Poll published to mesh (ID: ${shortId}...)`);
      setPollTitle("");
      setPollDescription("");
      setPollOptions(["Option 1", "Option 2"]);
      setTimeout(() => {
        onClose();
        setStatusMessage(null);
      }, 1200);
    } catch (err: any) {
      setErrorMessage(`Poll dispatch failed: ${err.toString()}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.75)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 900,
        padding: "1rem",
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "580px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.2)",
          border: "1px solid #e2e8f0",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1rem 1.25rem",
            background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 100%)",
            color: "#ffffff",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.2rem" }}>✍️</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: "1rem" }}>Quick Dispatcher</div>
              <div style={{ fontSize: "0.75rem", color: "#c7d2fe" }}>
                Dual-Broadcast to Local Relay & Mesh Nodes
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#c7d2fe",
              fontSize: "1.25rem",
              cursor: "pointer",
              padding: "0.25rem",
            }}
          >
            ✕
          </button>
        </div>

        {/* Tab Selector */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid #e2e8f0",
            background: "#f8fafc",
          }}
        >
          <button
            onClick={() => setTab("note")}
            style={{
              flex: 1,
              padding: "0.75rem",
              border: "none",
              borderBottom: tab === "note" ? "2px solid #4338ca" : "none",
              background: tab === "note" ? "#ffffff" : "transparent",
              fontWeight: tab === "note" ? 700 : 500,
              color: tab === "note" ? "#4338ca" : "#64748b",
              cursor: "pointer",
              fontSize: "0.88rem",
            }}
          >
            📝 Note (Kind 1)
          </button>
          <button
            onClick={() => setTab("media")}
            style={{
              flex: 1,
              padding: "0.75rem",
              border: "none",
              borderBottom: tab === "media" ? "2px solid #4338ca" : "none",
              background: tab === "media" ? "#ffffff" : "transparent",
              fontWeight: tab === "media" ? 700 : 500,
              color: tab === "media" ? "#4338ca" : "#64748b",
              cursor: "pointer",
              fontSize: "0.88rem",
            }}
          >
            🖼️ Media (Kind 1063)
          </button>
          <button
            onClick={() => setTab("poll")}
            style={{
              flex: 1,
              padding: "0.75rem",
              border: "none",
              borderBottom: tab === "poll" ? "2px solid #4338ca" : "none",
              background: tab === "poll" ? "#ffffff" : "transparent",
              fontWeight: tab === "poll" ? 700 : 500,
              color: tab === "poll" ? "#4338ca" : "#64748b",
              cursor: "pointer",
              fontSize: "0.88rem",
            }}
          >
            🗳️ Civic Poll (Kind 30023)
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ padding: "1.25rem", maxHeight: "65vh", overflowY: "auto" }}>
          {statusMessage && (
            <div
              style={{
                marginBottom: "1rem",
                padding: "0.75rem 1rem",
                background: "#ecfdf5",
                color: "#065f46",
                borderRadius: "6px",
                border: "1px solid #a7f3d0",
                fontSize: "0.88rem",
                fontWeight: 600,
              }}
            >
              {statusMessage}
            </div>
          )}

          {errorMessage && (
            <div
              style={{
                marginBottom: "1rem",
                padding: "0.75rem 1rem",
                background: "#fef2f2",
                color: "#991b1b",
                borderRadius: "6px",
                border: "1px solid #fecaca",
                fontSize: "0.88rem",
              }}
            >
              {errorMessage}
            </div>
          )}

          {/* TAB 1: Kind 1 Note */}
          {tab === "note" && (
            <div>
              <label
                style={{
                  display: "block",
                  fontSize: "0.85rem",
                  fontWeight: 600,
                  color: "#334155",
                  marginBottom: "0.35rem",
                }}
              >
                Broadcast Thought or Announcement
              </label>
              <textarea
                rows={5}
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder="What's happening across the sovereign mesh?"
                maxLength={500}
                style={{
                  width: "100%",
                  padding: "0.75rem",
                  borderRadius: "8px",
                  border: "1px solid #cbd5e1",
                  fontSize: "0.95rem",
                  fontFamily: "inherit",
                  resize: "vertical",
                  boxSizing: "border-box",
                }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "0.75rem",
                  color: "#64748b",
                  marginTop: "0.25rem",
                }}
              >
                <span>Signed via Level 1 Active Persona</span>
                <span>{noteContent.length} / 500</span>
              </div>

              <div style={{ marginTop: "1.25rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#f8fafc",
                    color: "#475569",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDispatchNote}
                  disabled={busy || !noteContent.trim()}
                  style={{
                    padding: "0.5rem 1.25rem",
                    borderRadius: "6px",
                    border: "none",
                    background: "#4338ca",
                    color: "#ffffff",
                    fontWeight: 600,
                    cursor: busy || !noteContent.trim() ? "not-allowed" : "pointer",
                    opacity: busy || !noteContent.trim() ? 0.6 : 1,
                  }}
                >
                  {busy ? "Signing & Sending…" : "Dispatch Note"}
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: Kind 1063 Media */}
          {tab === "media" && (
            <div>
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files?.[0]) {
                    setSelectedFile(e.dataTransfer.files[0]);
                  }
                }}
                style={{
                  border: "2px dashed #cbd5e1",
                  borderRadius: "10px",
                  padding: "1.75rem 1rem",
                  textAlign: "center",
                  background: "#f8fafc",
                  cursor: "pointer",
                  marginBottom: "1rem",
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    if (e.target.files?.[0]) {
                      setSelectedFile(e.target.files[0]);
                    }
                  }}
                />
                <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>📤</div>
                {selectedFile ? (
                  <div>
                    <div style={{ fontWeight: 600, color: "#1e293b", fontSize: "0.95rem" }}>
                      {selectedFile.name}
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "0.2rem" }}>
                      {(selectedFile.size / 1024).toFixed(1)} KB · {selectedFile.type || "binary"}
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontWeight: 600, color: "#334155" }}>
                      Drop file here or click to browse
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "#64748b", marginTop: "0.25rem" }}>
                      Files are SHA-256 hashed and uploaded directly to local Blossom PDS
                    </div>
                  </div>
                )}
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    color: "#334155",
                    marginBottom: "0.25rem",
                  }}
                >
                  Media Caption / Alt Text
                </label>
                <input
                  type="text"
                  value={mediaAlt}
                  onChange={(e) => setMediaAlt(e.target.value)}
                  placeholder="Describe the media payload"
                  style={{
                    width: "100%",
                    padding: "0.6rem 0.75rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "0.9rem",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#f8fafc",
                    color: "#475569",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDispatchMedia}
                  disabled={busy || !selectedFile}
                  style={{
                    padding: "0.5rem 1.25rem",
                    borderRadius: "6px",
                    border: "none",
                    background: "#4338ca",
                    color: "#ffffff",
                    fontWeight: 600,
                    cursor: busy || !selectedFile ? "not-allowed" : "pointer",
                    opacity: busy || !selectedFile ? 0.6 : 1,
                  }}
                >
                  {busy ? "Uploading & Signing…" : "Dispatch Media"}
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: Kind 30023 Civic Poll */}
          {tab === "poll" && (
            <div>
              <div style={{ marginBottom: "0.85rem" }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    color: "#334155",
                    marginBottom: "0.25rem",
                  }}
                >
                  Poll Question / Title
                </label>
                <input
                  type="text"
                  value={pollTitle}
                  onChange={(e) => setPollTitle(e.target.value)}
                  placeholder="e.g. Upgrade quorum threshold for Protocol v2.1?"
                  style={{
                    width: "100%",
                    padding: "0.6rem 0.75rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "0.9rem",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ marginBottom: "0.85rem" }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    color: "#334155",
                    marginBottom: "0.25rem",
                  }}
                >
                  Context & Details (Optional)
                </label>
                <textarea
                  rows={2}
                  value={pollDescription}
                  onChange={(e) => setPollDescription(e.target.value)}
                  placeholder="Provide background context or references for voters"
                  style={{
                    width: "100%",
                    padding: "0.6rem 0.75rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "0.9rem",
                    fontFamily: "inherit",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ marginBottom: "0.85rem" }}>
                <label
                  style={{
                    display: "block",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    color: "#334155",
                    marginBottom: "0.35rem",
                  }}
                >
                  Voting Options
                </label>
                {pollOptions.map((opt, idx) => (
                  <div key={idx} style={{ display: "flex", gap: "0.4rem", marginBottom: "0.4rem" }}>
                    <input
                      type="text"
                      value={opt}
                      onChange={(e) => handleOptionChange(idx, e.target.value)}
                      placeholder={`Option ${idx + 1}`}
                      style={{
                        flex: 1,
                        padding: "0.5rem 0.65rem",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        fontSize: "0.88rem",
                      }}
                    />
                    {pollOptions.length > 2 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveOption(idx)}
                        style={{
                          background: "#fee2e2",
                          border: "1px solid #fecaca",
                          color: "#991b1b",
                          borderRadius: "6px",
                          padding: "0.4rem 0.6rem",
                          cursor: "pointer",
                          fontSize: "0.8rem",
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {pollOptions.length < 8 && (
                  <button
                    type="button"
                    onClick={handleAddOption}
                    style={{
                      background: "transparent",
                      border: "1px dashed #94a3b8",
                      color: "#475569",
                      borderRadius: "6px",
                      padding: "0.35rem 0.75rem",
                      cursor: "pointer",
                      fontSize: "0.8rem",
                      marginTop: "0.2rem",
                    }}
                  >
                    + Add Option
                  </button>
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "1rem" }}>
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      color: "#334155",
                      marginBottom: "0.25rem",
                    }}
                  >
                    Minimum Fidelity Tier
                  </label>
                  <select
                    value={minFidelity}
                    onChange={(e) => setMinFidelity(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "0.5rem 0.65rem",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "0.85rem",
                    }}
                  >
                    <option value="social">Social (Self-Issued / L1)</option>
                    <option value="institutional">Institutional (KYC / Org)</option>
                    <option value="hardware">Hardware (Secure Enclave / PRF)</option>
                  </select>
                </div>
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.82rem",
                      fontWeight: 600,
                      color: "#334155",
                      marginBottom: "0.25rem",
                    }}
                  >
                    Poll Duration
                  </label>
                  <select
                    value={durationHours}
                    onChange={(e) => setDurationHours(Number(e.target.value))}
                    style={{
                      width: "100%",
                      padding: "0.5rem 0.65rem",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "0.85rem",
                    }}
                  >
                    <option value={24}>24 Hours</option>
                    <option value={48}>48 Hours</option>
                    <option value={168}>7 Days</option>
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#f8fafc",
                    color: "#475569",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDispatchPoll}
                  disabled={busy || !pollTitle.trim() || pollOptions.some((o) => !o.trim())}
                  style={{
                    padding: "0.5rem 1.25rem",
                    borderRadius: "6px",
                    border: "none",
                    background: "#4338ca",
                    color: "#ffffff",
                    fontWeight: 600,
                    cursor: busy || !pollTitle.trim() ? "not-allowed" : "pointer",
                    opacity: busy || !pollTitle.trim() ? 0.6 : 1,
                  }}
                >
                  {busy ? "Signing & Creating…" : "Create Civic Poll"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
