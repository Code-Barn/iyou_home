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

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import NeutralAgeGate from "./NeutralAgeGate";
import type { AgeGateRecord } from "../../lib/types";

interface FirstRunGatewayProps {
  /** Invoked once the vault is provisioned (create, seed-restore, or
   *  backup-restore) and the seed ceremony has been completed. The parent
   *  uses this to trigger `start_ready_services` and enter the app. */
  onInitialized: () => void;
}

/** Ceremony acknowledgment phrase typed verbatim as the completion proof. */
const ACK_PHRASE = "I HAVE WRITTEN THIS DOWN";

type Step =
  | "landing"
  | "age-gate"
  | "seed-ceremony"
  | "parent-pairing"
  | "restore-choice"
  | "restore-backup"
  | "restore-seed";

const seedWords = (seedHex: string): string[] => {
  const normalized = seedHex.toLowerCase();
  const words: string[] = [];
  for (let i = 0; i < normalized.length; i += 4) {
    words.push(normalized.slice(i, i + 4));
  }
  return words;
};

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

/**
 * First-run onboarding gateway. Rendered full-screen whenever the vault is in
 * the "Uninitialized" state so a greenfield vault is never silently
 * bootstrapped and no daemon or signature bridge binds before an active
 * Level 1 persona exists. Offers an explicit Create-vs-Restore choice.
 */
export default function FirstRunGateway({ onInitialized }: FirstRunGatewayProps) {
  const [step, setStep] = useState<Step>("landing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed ceremony state (Create path).
  const [seedHex, setSeedHex] = useState<string | null>(null);
  const [mode, setMode] = useState<"challenge" | "ack">("challenge");
  const [challengeIndices, setChallengeIndices] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [ackText, setAckText] = useState("");
  const [blurredFields, setBlurredFields] = useState<Record<number, boolean>>({});

  // Restore state.
  const [pendingBackupBytes, setPendingBackupBytes] = useState<number[] | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreSeed, setRestoreSeed] = useState("");

  const words = useMemo(() => (seedHex ? seedWords(seedHex) : []), [seedHex]);

  const resetCeremony = () => {
    setSeedHex(null);
    setMode("challenge");
    setAnswers({});
    setAckText("");
    setBlurredFields({});
    setPendingBackupBytes(null);
    setRestorePassword("");
    setRestoreSeed("");
    setError(null);
  };

  const goTo = (next: Step) => {
    setError(null);
    setStep(next);
  };

  // ---------- Create path ----------

  /** RFC-004 neutral age gate: only Adult/Teen reach the seed ceremony. */
  const handleAgeGateDecision = (_record: AgeGateRecord) => {
    void handleCreate();
  };

  const handleNeedsParentPairing = () => {
    // Child (<13): seed generation is halted; only exit is parent pairing
    // (RFC-005 supervisory delegation, pending).
    goTo("parent-pairing");
  };

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      // Bootstraps the vault (L0 Anchor + L1 Primary) and points the active
      // signer at the primary persona; returns its DID.
      await invoke<string>("generate_did");
      const hex = await invoke<string>("reveal_master_seed");
      setSeedHex(hex);
      const count = seedWords(hex).length;
      setChallengeIndices(pickRandomIndices(Math.min(3, count), count));
      setStep("seed-ceremony");
    } catch (err: any) {
      setError(`Failed to create identity: ${err.toString()}`);
    } finally {
      setBusy(false);
    }
  };

  const reshuffle = () => {
    if (!words.length) return;
    setAnswers({});
    setBlurredFields({});
    setChallengeIndices(pickRandomIndices(Math.min(3, words.length), words.length));
  };

  const isChallengeComplete =
    step === "seed-ceremony" &&
    mode === "challenge" &&
    challengeIndices.length > 0 &&
    challengeIndices.every((idx) => {
      const userVal = (answers[idx] || "").trim().toLowerCase();
      const expectedVal = (words[idx] || "").trim().toLowerCase();
      return userVal.length > 0 && userVal === expectedVal;
    });

  const normalizedTyped = ackText.trim().toLowerCase().replace(/['’]/g, "");
  const isValidPhrase =
    step === "seed-ceremony" &&
    mode === "ack" &&
    (normalizedTyped === "i have written this down" ||
      normalizedTyped === "ive written this down");

  const isCeremonyValid = isChallengeComplete || isValidPhrase;

  const handleConfirmSeed = async () => {
    if (!isCeremonyValid) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("set_seed_backup_confirmed", { confirmed: true });
      onInitialized();
    } catch (err: any) {
      setError(`Failed to confirm seed backup: ${err.toString()}`);
      setBusy(false);
    }
  };

  // ---------- Restore paths ----------

  const handlePickBackup = async () => {
    setBusy(true);
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "iyou Backup", extensions: ["iyoubackup"] }],
      });
      if (!selected) return;
      const bytes = await invoke<number[]>("read_binary_file", { path: selected });
      setPendingBackupBytes(bytes);
      setRestorePassword("");
      setStep("restore-backup");
    } catch (err: any) {
      setError(`Failed to read backup file: ${err.toString()}`);
    } finally {
      setBusy(false);
    }
  };

  const handleExecuteBackupRestore = async () => {
    if (!restorePassword.trim() || !pendingBackupBytes) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("restore_vault_backup", {
        backupBytes: pendingBackupBytes,
        password: restorePassword,
      });
      // The user holds their backup — the ceremony is complete.
      await invoke("set_seed_backup_confirmed", { confirmed: true });
      onInitialized();
    } catch (err: any) {
      setError(`Restore failed: ${err.toString()}`);
      setBusy(false);
    }
  };

  const handleRestoreFromSeed = async () => {
    if (!restoreSeed.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Backend parses hex or base58, derives L0/L1 deterministically,
      // refuses to overwrite an existing vault, and marks the seed backup
      // as confirmed before returning.
      await invoke("bootstrap_from_seed", { seedPhraseOrHex: restoreSeed.trim() });
      onInitialized();
    } catch (err: any) {
      setError(`Seed restore failed: ${err.toString()}`);
      setBusy(false);
    }
  };

  // ---------- Rendering ----------

  const wrapperStyle: CSSProperties = {
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
  };

  const cardStyle: CSSProperties = {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(199, 210, 254, 0.2)",
    borderRadius: "16px",
    padding: "2rem",
    maxWidth: "680px",
    width: "100%",
    backdropFilter: "blur(8px)",
  };

  const actionButtonStyle = (enabled: boolean): CSSProperties => ({
    width: "100%",
    background: enabled ? "#10b981" : "rgba(255,255,255,0.08)",
    color: "#ffffff",
    fontWeight: 700,
    border: enabled ? "none" : "1px solid #a5b4fc",
    padding: "0.8rem 1.4rem",
    borderRadius: "8px",
    opacity: busy ? 0.6 : 1,
    cursor: busy || !enabled ? "not-allowed" : "pointer",
    fontSize: "1rem",
    transition: "opacity 0.2s, background-color 0.2s",
  });

  const secondaryButtonStyle: CSSProperties = {
    background: "transparent",
    border: "1px solid #a5b4fc",
    color: "#e0e7ff",
    padding: "0.6rem 1rem",
    borderRadius: "6px",
    cursor: busy ? "not-allowed" : "pointer",
    fontSize: "0.88rem",
  };

  return (
    <div style={wrapperStyle} data-testid="first-run-gateway">
      <div style={cardStyle}>
        <h2 style={{ margin: "0 0 0.25rem 0", color: "#fff" }}>
          {"\uD83D\uDEE1\uFE0F"} Sovereign Onboarding
        </h2>
        <p
          style={{
            margin: "0 0 1.5rem 0",
            fontSize: "0.95rem",
            color: "#c7d2fe",
            lineHeight: 1.6,
          }}
        >
          <strong>iyou_home</strong> is a self-sovereign identity enclave. Your
          identity lives only on this device until you back it up. Choose how
          to begin.
        </p>

        {error && (
          <div
            style={{
              marginBottom: "1rem",
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

        {step === "landing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <button
              onClick={() => goTo("age-gate")}
              disabled={busy}
              data-testid="gateway-create"
              style={actionButtonStyle(true)}
            >
              ✦ Create Sovereign Identity
            </button>
            <p
              style={{
                margin: 0,
                fontSize: "0.8rem",
                color: "#a5b4fc",
                textAlign: "center",
              }}
            >
              Mints your Anchor (L0) and Primary (L1) identities from a fresh
              root seed, then walks you through writing it down.
            </p>
            <button
              onClick={() => goTo("restore-choice")}
              disabled={busy}
              data-testid="gateway-restore"
              style={actionButtonStyle(false)}
            >
              ⟲ Sync / Restore Existing Device
            </button>
            <p
              style={{
                margin: 0,
                fontSize: "0.8rem",
                color: "#a5b4fc",
                textAlign: "center",
              }}
            >
              Recover an existing identity from an encrypted{" "}
              <code>.iyoubackup</code> archive or a master seed phrase.
            </p>
          </div>
        )}

        {step === "age-gate" && (
          <div data-testid="gateway-age-gate">
            <h3 style={{ margin: "0 0 0.25rem 0", color: "#fff" }}>
              🛡️ Let&apos;s Get Started
            </h3>
            <p
              style={{
                margin: "0 0 1rem 0",
                fontSize: "0.9rem",
                color: "#c7d2fe",
                lineHeight: 1.5,
              }}
            >
              Confirm your birth month and year to continue.
            </p>
            <NeutralAgeGate
              onDecision={handleAgeGateDecision}
              onNeedsParentPairing={handleNeedsParentPairing}
            />
            <button
              onClick={() => goTo("landing")}
              disabled={busy}
              style={{ ...secondaryButtonStyle, marginTop: "1rem" }}
            >
              ← Back
            </button>
          </div>
        )}

        {step === "parent-pairing" && (
          <div data-testid="gateway-parent-pairing">
            <h3 style={{ margin: "0 0 0.5rem 0", color: "#fff" }}>
              🤝 Pair with Parent Enclave
            </h3>
            <p
              style={{
                margin: "0 0 1rem 0",
                fontSize: "0.95rem",
                color: "#c7d2fe",
                lineHeight: 1.6,
              }}
            >
              To setup an identity for an individual under 13, please pair this
              device with a parent or guardian&apos;s iyou_home enclave.
            </p>
            <div
              style={{
                borderRadius: "10px",
                border: "1px dashed #a5b4fc",
                padding: "1.25rem",
                textAlign: "center",
                color: "#c7d2fe",
                fontSize: "0.9rem",
              }}
            >
              <p style={{ margin: "0 0 0.5rem 0" }}>
                Waiting for a parent or guardian enclave…
              </p>
              <p
                style={{
                  margin: 0,
                  fontSize: "0.8rem",
                  color: "#a5b4fc",
                }}
              >
                Supervisory delegation (RFC-005) will resume here. Seed
                generation stays blocked until a parent pair completes.
              </p>
            </div>
            <button
              onClick={() => goTo("landing")}
              disabled={busy}
              style={{ ...secondaryButtonStyle, marginTop: "1rem" }}
            >
              ← Back
            </button>
          </div>
        )}

        {step === "seed-ceremony" &&
          (seedHex === null ? (
            <p style={{ color: "#c7d2fe" }}>Loading seed…</p>
          ) : (
            <div data-testid="gateway-seed-ceremony">
              <h3 style={{ margin: "0 0 0.5rem 0", color: "#fff" }}>
                ✍️ Write Down Your Recovery Seed
              </h3>
              <p
                style={{
                  margin: "0 0 1rem 0",
                  fontSize: "0.9rem",
                  color: "#c7d2fe",
                  lineHeight: 1.5,
                }}
              >
                This is the root of every persona, credential, and recovery
                path. Store it offline, in writing. Never photograph or share
                it. You cannot proceed until you prove you have recorded it.
              </p>
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
                    <span
                      style={{
                        opacity: 0.5,
                        fontSize: "0.75rem",
                        marginRight: "2px",
                      }}
                    >
                      #{i + 1}
                    </span>
                    {word}
                    {i % 4 === 3 ? <br /> : " "}
                  </span>
                ))}
              </div>

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
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                          }}
                        >
                          <input
                            type="text"
                            maxLength={4}
                            value={answers[idx] ?? ""}
                            data-chunk-index={idx}
                            onChange={(e) =>
                              setAnswers((prev) => ({
                                ...prev,
                                [idx]: e.target.value.trim(),
                              }))
                            }
                            onBlur={() =>
                              setBlurredFields((prev) => ({ ...prev, [idx]: true }))
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
                            }}
                          />
                          {isMatch && (
                            <span style={{ color: "#10b981", fontSize: "0.82rem", fontWeight: 600 }}>
                              ✓ Correct
                            </span>
                          )}
                          {isMismatch && (
                            <span style={{ color: "#ef4444", fontSize: "0.82rem" }}>
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
                    style={secondaryButtonStyle}
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
                  <input
                    type="text"
                    value={ackText}
                    onChange={(e) => setAckText(e.target.value)}
                    placeholder={ACK_PHRASE}
                    data-testid="gateway-ack-input"
                    autoComplete="off"
                    style={{
                      width: "100%",
                      padding: "0.65rem 0.75rem",
                      borderRadius: "6px",
                      border: isValidPhrase
                        ? "1px solid rgba(16, 185, 129, 0.6)"
                        : "1px solid #6366f1",
                      background: isValidPhrase ? "rgba(6, 78, 59, 0.25)" : "#0f172a",
                      color: isValidPhrase ? "#6ee7b7" : "#e0e7ff",
                      fontSize: "0.95rem",
                      letterSpacing: "0.04em",
                    }}
                  />
                  <p
                    style={{
                      fontSize: "0.75rem",
                      color: isValidPhrase ? "#10b981" : "#a5b4fc",
                      margin: "0.5rem 0 0 0",
                      fontWeight: isValidPhrase ? 600 : 400,
                    }}
                  >
                    {isValidPhrase
                      ? "✓ Phrase verified"
                      : `You can type: ${ACK_PHRASE}`}
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
                  onClick={handleConfirmSeed}
                  disabled={busy || !isCeremonyValid}
                  data-testid="gateway-confirm-seed"
                  style={{
                    background: "#10b981",
                    color: "#ffffff",
                    fontWeight: 700,
                    border: "none",
                    padding: "0.65rem 1.4rem",
                    borderRadius: "6px",
                    opacity: busy || !isCeremonyValid ? 0.45 : 1,
                    cursor: busy || !isCeremonyValid ? "not-allowed" : "pointer",
                  }}
                >
                  {busy ? "Saving…" : "I've Written This Down"}
                </button>
                <button
                  onClick={() => {
                    setMode(mode === "challenge" ? "ack" : "challenge");
                    setAckText("");
                    setError(null);
                  }}
                  disabled={busy}
                  style={secondaryButtonStyle}
                >
                  {mode === "challenge"
                    ? "Use the typed acknowledgment instead"
                    : "Back to word challenge"}
                </button>
              </div>
            </div>
          ))}

        {step === "restore-choice" && (
          <div
            data-testid="gateway-restore-choice"
            style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
          >
            <button
              onClick={handlePickBackup}
              disabled={busy}
              data-testid="gateway-restore-backup"
              style={actionButtonStyle(true)}
            >
              📦 Restore from .iyoubackup Archive
            </button>
            <p
              style={{
                margin: 0,
                fontSize: "0.8rem",
                color: "#a5b4fc",
                textAlign: "center",
              }}
            >
              Pick an encrypted snapshot and enter its password.
            </p>
            <button
              onClick={() => goTo("restore-seed")}
              disabled={busy}
              data-testid="gateway-restore-seed"
              style={actionButtonStyle(true)}
            >
              🔑 Restore from Master Seed
            </button>
            <p
              style={{
                margin: 0,
                fontSize: "0.8rem",
                color: "#a5b4fc",
                textAlign: "center",
              }}
            >
              Paste your 64-char hex seed or base58 seed. Your Anchor and
              Primary identities are derived deterministically on this device.
            </p>
            <button
              onClick={() => goTo("landing")}
              disabled={busy}
              style={secondaryButtonStyle}
            >
              ← Back
            </button>
          </div>
        )}

        {step === "restore-backup" &&
          (pendingBackupBytes === null ? (
            <p style={{ color: "#c7d2fe" }}>Selecting backup file…</p>
          ) : (
            <div data-testid="gateway-restore-backup-panel">
              <h3 style={{ margin: "0 0 0.5rem 0", color: "#fff" }}>
                🔐 Unlock Backup Archive
              </h3>
              <p
                style={{
                  margin: "0 0 1rem 0",
                  fontSize: "0.9rem",
                  color: "#c7d2fe",
                }}
              >
                Enter the password this archive was encrypted with.
              </p>
              <input
                type="password"
                value={restorePassword}
                onChange={(e) => setRestorePassword(e.target.value)}
                placeholder="Backup password"
                data-testid="gateway-backup-password"
                autoComplete="off"
                style={{
                  width: "100%",
                  padding: "0.65rem 0.75rem",
                  borderRadius: "6px",
                  border: "1px solid #6366f1",
                  background: "#0f172a",
                  color: "#e0e7ff",
                  fontSize: "0.95rem",
                  marginBottom: "1rem",
                }}
              />
              <button
                onClick={handleExecuteBackupRestore}
                disabled={busy || !restorePassword.trim()}
                data-testid="gateway-restore-backup-confirm"
                style={{
                  background: "#10b981",
                  color: "#ffffff",
                  fontWeight: 700,
                  border: "none",
                  padding: "0.65rem 1.4rem",
                  borderRadius: "6px",
                  opacity: busy || !restorePassword.trim() ? 0.45 : 1,
                  cursor: busy || !restorePassword.trim() ? "not-allowed" : "pointer",
                }}
              >
                {busy ? "Restoring…" : "Restore Vault"}
              </button>
              <button
                onClick={() => goTo("restore-choice")}
                disabled={busy}
                style={{ ...secondaryButtonStyle, marginLeft: "0.75rem" }}
              >
                ← Back
              </button>
            </div>
          ))}

        {step === "restore-seed" && (
          <div data-testid="gateway-restore-seed-panel">
            <h3 style={{ margin: "0 0 0.5rem 0", color: "#fff" }}>
              🔑 Restore from Master Seed
            </h3>
            <p
              style={{
                margin: "0 0 0.75rem 0",
                fontSize: "0.9rem",
                color: "#c7d2fe",
              }}
            >
              Paste a 64-character hexadecimal seed or a base58 seed. The vault
              is recreated deterministically and will not overwrite an existing
              identity.
            </p>
            <textarea
              value={restoreSeed}
              onChange={(e) => setRestoreSeed(e.target.value)}
              placeholder={"64-char hex (e.g. 4f6f…b2) or base58 seed"}
              data-testid="gateway-seed-input"
              autoComplete="off"
              spellCheck={false}
              rows={3}
              style={{
                width: "100%",
                padding: "0.65rem 0.75rem",
                borderRadius: "6px",
                border: "1px solid #6366f1",
                background: "#0f172a",
                color: "#e0e7ff",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.9rem",
                letterSpacing: "0.04em",
                resize: "vertical",
                marginBottom: "1rem",
              }}
            />
            <button
              onClick={handleRestoreFromSeed}
              disabled={busy || !restoreSeed.trim()}
              data-testid="gateway-restore-seed-confirm"
              style={{
                background: "#10b981",
                color: "#ffffff",
                fontWeight: 700,
                border: "none",
                padding: "0.65rem 1.4rem",
                borderRadius: "6px",
                opacity: busy || !restoreSeed.trim() ? 0.45 : 1,
                cursor: busy || !restoreSeed.trim() ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "Restoring…" : "Restore Vault"}
            </button>
            <button
              onClick={() => {
                resetCeremony();
                goTo("restore-choice");
              }}
              disabled={busy}
              style={{ ...secondaryButtonStyle, marginLeft: "0.75rem" }}
            >
              ← Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}