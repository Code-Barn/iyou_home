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

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface FirstRunSeedGateProps {
  /** Invoked after the ceremony succeeds and `seed_backup_confirmed` is saved. */
  onConfirmed: () => void;
}

/** Split a 64-hex seed into 4-hex "words" for the verification challenge. */
function seedWords(seedHex: string): string[] {
  const normalized = seedHex.toLowerCase();
  const words: string[] = [];
  for (let i = 0; i < normalized.length; i += 4) {
    words.push(normalized.slice(i, i + 4));
  }
  return words;
}

function pickRandomIndices(count: number, max: number): number[] {
  const indices: number[] = [];
  while (indices.length < count) {
    let next: number;
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const buffer = new Uint32Array(1);
      crypto.getRandomValues(buffer);
      next = buffer[0] % max;
    } else {
      next = Math.floor(Math.random() * max);
    }
    if (!indices.includes(next)) {
      indices.push(next);
    }
  }
  return indices;
}

/** Ceremony acknowledgment phrase typed verbatim as an alternate path. */
const ACK_PHRASE = "I HAVE SAVED MY SEED";

export default function FirstRunSeedGate({ onConfirmed }: FirstRunSeedGateProps) {
  const [seedHex, setSeedHex] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<"challenge" | "ack">("challenge");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [ackText, setAckText] = useState("");
  const [challengeIndices, setChallengeIndices] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [blurredFields, setBlurredFields] = useState<Record<number, boolean>>({});

  const words = useMemo(() => (seedHex ? seedWords(seedHex) : []), [seedHex]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const hex = await invoke<string>("reveal_master_seed");
        if (!mounted) return;
        setSeedHex(hex);
        const wordCount = seedWords(hex).length;
        setChallengeIndices(pickRandomIndices(Math.min(3, wordCount), wordCount));
      } catch (err: any) {
        if (mounted) setLoadError(err.toString());
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const reshuffle = () => {
    if (!words.length) return;
    setAnswers({});
    setBlurredFields({});
    setError(null);
    setChallengeIndices(pickRandomIndices(Math.min(3, words.length), words.length));
  };

  // Resilient challenge validation: all required slots must be non-empty and match case-insensitively
  const isChallengeComplete =
    mode === "challenge" &&
    challengeIndices.length > 0 &&
    challengeIndices.every((idx) => {
      const userVal = (answers[idx] || "").trim().toLowerCase();
      const expectedVal = (words[idx] || "").trim().toLowerCase();
      return userVal.length > 0 && userVal === expectedVal;
    });

  // Permissive typed confirmation: accept common phrase variations and punctuation
  const normalizedTyped = ackText.trim().toLowerCase().replace(/['’]/g, "");
  const isValidPhrase =
    mode === "ack" &&
    (normalizedTyped === "i have saved my seed" ||
      normalizedTyped === "ive saved my seed" ||
      normalizedTyped === "i saved my seed");

  const isFormValid = isChallengeComplete || isValidPhrase;

  const handleConfirm = async () => {
    if (!isFormValid) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("set_seed_backup_confirmed", { confirmed: true });
      onConfirmed();
    } catch (err: any) {
      setError(`Failed to confirm seed backup: ${err.toString()}`);
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        overflow: "auto",
        background:
          "linear-gradient(160deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "3rem 1.5rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#e0e7ff",
      }}
    >
      <div
        style={{
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(199, 210, 254, 0.2)",
          borderRadius: "16px",
          padding: "2rem",
          maxWidth: "680px",
          width: "100%",
          backdropFilter: "blur(8px)",
        }}
      >
        <h2 style={{ margin: "0 0 0.25rem 0", color: "#fff" }}>
          {"\uD83D\uDEE1\uFE0F"} Master Seed Backup
        </h2>
        <p
          style={{
            margin: "0 0 1.5rem 0",
            fontSize: "0.95rem",
            color: "#c7d2fe",
            lineHeight: 1.6,
          }}
        >
          Before you use <strong>iyou_home</strong>, write down your master
          seed. It is the root of every persona, credential, and recovery
          path. If you lose it, your identity cannot be restored.
        </p>

        {loadError ? (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              borderRadius: "8px",
              padding: "0.75rem 1rem",
              fontSize: "0.88rem",
            }}
          >
            Could not load the master seed: {loadError}
          </div>
        ) : !seedHex ? (
          <p style={{ color: "#c7d2fe" }}>Loading seed…</p>
        ) : (
          <>
            {/* Seed display, grouped into 4-hex words */}
            <div
              style={{
                background: "#1e1b4b",
                border: "1px solid #6366f1",
                borderRadius: "10px",
                padding: "1rem 1.25rem",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "1.05rem",
                color: "#c7d2fe",
                lineHeight: "1.9",
                letterSpacing: "0.05em",
                wordBreak: "break-all",
                marginBottom: "1rem",
                userSelect: "text",
              }}
            >
              {words.map((word, i) => (
                <span key={i} style={{ whiteSpace: "nowrap" }}>
                  <span style={{ opacity: 0.5, fontSize: "0.75rem", marginRight: "2px" }}>
                    #{i + 1}
                  </span>
                  {word}
                  {i % 4 === 3 ? <br /> : " "}
                </span>
              ))}
            </div>
            <p
              style={{
                fontSize: "0.8rem",
                color: "#a5b4fc",
                margin: "0 0 1.5rem 0",
              }}
            >
              This is the 64-character hex root seed. Store it offline, in
              writing. Never photograph or share it.
            </p>

            {mode === "challenge" ? (
              <div>
                <p
                  style={{
                    fontSize: "0.9rem",
                    margin: "0 0 0.75rem 0",
                    color: "#c7d2fe",
                  }}
                >
                  Verify you recorded it — type the highlighted{" "}
                  {challengeIndices.length} seed chunks below:
                </p>
                {challengeIndices.map((idx) => {
                  const userVal = (answers[idx] || "").trim().toLowerCase();
                  const expectedVal = (words[idx] || "").trim().toLowerCase();
                  const isMatch = userVal.length > 0 && userVal === expectedVal;
                  const isBlurred = !!blurredFields[idx];
                  const isMismatch = isBlurred && userVal.length > 0 && !isMatch;

                  let borderStyle = "1px solid #6366f1";
                  let bgStyle = "#0f172a";
                  let textColor = "#e0e7ff";

                  if (isMatch) {
                    borderStyle = "1px solid rgba(16, 185, 129, 0.6)";
                    bgStyle = "rgba(6, 78, 59, 0.25)";
                    textColor = "#6ee7b7";
                  } else if (isMismatch) {
                    borderStyle = "1px solid rgba(239, 68, 68, 0.6)";
                    bgStyle = "rgba(127, 29, 29, 0.2)";
                    textColor = "#fca5a5";
                  }

                  return (
                    <div key={idx} style={{ marginBottom: "0.75rem" }}>
                      <label
                        style={{
                          display: "block",
                          fontSize: "0.78rem",
                          color: "#a5b4fc",
                          marginBottom: "0.25rem",
                        }}
                      >
                        Chunk #{idx + 1}
                      </label>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <input
                          type="text"
                          maxLength={4}
                          value={answers[idx] ?? ""}
                          onChange={(e) =>
                            setAnswers((prev) => ({
                              ...prev,
                              [idx]: e.target.value.trim(),
                            }))
                          }
                          onBlur={() =>
                            setBlurredFields((prev) => ({
                              ...prev,
                              [idx]: true,
                            }))
                          }
                          placeholder="4 hex chars"
                          autoComplete="off"
                          style={{
                            width: "140px",
                            padding: "0.5rem 0.75rem",
                            borderRadius: "6px",
                            border: borderStyle,
                            background: bgStyle,
                            color: textColor,
                            fontFamily: "monospace",
                            fontSize: "0.95rem",
                            letterSpacing: "0.15em",
                            textTransform: "lowercase",
                            transition: "border-color 0.2s, background-color 0.2s",
                          }}
                        />
                        {isMatch && (
                          <span
                            style={{
                              color: "#10b981",
                              fontSize: "0.82rem",
                              fontWeight: 600,
                            }}
                          >
                            ✓ Correct
                          </span>
                        )}
                        {isMismatch && (
                          <span
                            style={{
                              color: "#ef4444",
                              fontSize: "0.82rem",
                            }}
                          >
                            Check chunk #{idx + 1}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <button
                  onClick={reshuffle}
                  disabled={busy}
                  style={{
                    background: "transparent",
                    border: "1px solid #a5b4fc",
                    color: "#e0e7ff",
                    padding: "0.4rem 0.8rem",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                    marginTop: "0.25rem",
                  }}
                >
                  Use different chunks
                </button>
              </div>
            ) : (
              <div>
                <p
                  style={{
                    fontSize: "0.9rem",
                    margin: "0 0 0.75rem 0",
                    color: "#c7d2fe",
                  }}
                >
                  Type the acknowledgment exactly as shown:
                </p>
                <div style={{ position: "relative" }}>
                  <input
                    type="text"
                    value={ackText}
                    onChange={(e) => setAckText(e.target.value)}
                    placeholder={ACK_PHRASE}
                    autoComplete="off"
                    style={{
                      width: "100%",
                      padding: "0.65rem 0.75rem",
                      borderRadius: "6px",
                      border: isValidPhrase
                        ? "1px solid rgba(16, 185, 129, 0.6)"
                        : "1px solid #6366f1",
                      background: isValidPhrase
                        ? "rgba(6, 78, 59, 0.25)"
                        : "#0f172a",
                      color: isValidPhrase ? "#6ee7b7" : "#e0e7ff",
                      fontSize: "0.95rem",
                      letterSpacing: "0.04em",
                      transition: "border-color 0.2s, background-color 0.2s",
                    }}
                  />
                </div>
                <p
                  style={{
                    fontSize: "0.75rem",
                    color: isValidPhrase ? "#10b981" : "#a5b4fc",
                    margin: "0.5rem 0 0 0",
                    fontWeight: isValidPhrase ? 600 : 400,
                  }}
                >
                  {isValidPhrase ? "✓ Phrase verified" : `You can type: ${ACK_PHRASE}`}
                </p>
              </div>
            )}

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "1rem",
                marginTop: "1.25rem",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={handleConfirm}
                disabled={busy || !isFormValid}
                style={{
                  background: "#10b981",
                  color: "#ffffff",
                  fontWeight: 700,
                  border: "none",
                  padding: "0.65rem 1.4rem",
                  borderRadius: "6px",
                  opacity: busy || !isFormValid ? 0.45 : 1,
                  cursor: busy || !isFormValid ? "not-allowed" : "pointer",
                  boxShadow:
                    !busy && isFormValid
                      ? "0 2px 10px rgba(16, 185, 129, 0.35)"
                      : "none",
                  transition: "opacity 0.2s, background-color 0.2s, transform 0.1s",
                }}
              >
                {busy ? "Saving…" : "I've Saved My Seed"}
              </button>
              <button
                onClick={() => {
                  setMode(mode === "challenge" ? "ack" : "challenge");
                  setAckText("");
                  setError(null);
                }}
                disabled={busy}
                style={{
                  background: "transparent",
                  border: "1px solid #a5b4fc",
                  color: "#e0e7ff",
                  padding: "0.65rem 1rem",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "0.88rem",
                }}
              >
                {mode === "challenge"
                  ? "Use the typed acknowledgment instead"
                  : "Back to word challenge"}
              </button>
            </div>

            {error && (
              <div
                style={{
                  marginTop: "1rem",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  color: "#b91c1c",
                  borderRadius: "8px",
                  padding: "0.75rem 1rem",
                  fontSize: "0.88rem",
                }}
              >
                {error}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}