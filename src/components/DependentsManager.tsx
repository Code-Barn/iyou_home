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

import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { DependentProfile, DependentProvisioningBundle } from "../lib/types";

export function getAgeBracketLabel(birthYear: number, custodyStage?: number): string {
  const currentYear = new Date().getFullYear();
  const age = currentYear - birthYear;
  if (custodyStage === 1 || age < 13) {
    return "Child (<13)";
  }
  if (custodyStage === 2 || (age >= 13 && age < 18)) {
    return "Teen (13–17)";
  }
  return "Adult (18+)";
}

export function getCustodyStageLabel(stage: number): string {
  switch (stage) {
    case 1:
      return "Guided Delegation";
    case 2:
      return "Autonomous";
    case 3:
      return "Sovereign Eligible";
    default:
      return "Standard";
  }
}

export function shortDid(did: string): string {
  if (!did || did.length <= 20) return did || "";
  return `${did.slice(0, 12)}…${did.slice(-8)}`;
}

export default function DependentsManager() {
  const [dependents, setDependents] = useState<DependentProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Provisioning modal state
  const [selectedDep, setSelectedDep] = useState<DependentProfile | null>(null);
  const [provisionBundle, setProvisionBundle] = useState<DependentProvisioningBundle | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [provisionLoading, setProvisionLoading] = useState(false);
  const [bundleCopied, setBundleCopied] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Add dependent modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBirthYear, setNewBirthYear] = useState(new Date().getFullYear() - 10);
  const [newCustodyStage, setNewCustodyStage] = useState<1 | 2>(1);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Emancipation guard state
  const [armEmancipateId, setArmEmancipateId] = useState<string | null>(null);
  const [emancipateLoading, setEmancipateLoading] = useState(false);
  const [emancipateSuccessMsg, setEmancipateSuccessMsg] = useState<string | null>(null);

  const loadDependents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invoke<DependentProfile[]>("list_dependents");
      setDependents(res || []);
      setError(null);
    } catch (err) {
      // In standalone test environments or uninitialized vaults, fail gracefully
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDependents();
  }, [loadDependents]);

  const handleOpenProvision = async (dep: DependentProfile) => {
    setSelectedDep(dep);
    setProvisionBundle(null);
    setQrDataUrl(null);
    setBundleCopied(false);
    setModalError(null);
    setProvisionLoading(true);

    try {
      const bundle = await invoke<DependentProvisioningBundle>("get_dependent_provisioning_bundle", {
        dependentId: dep.dependent_id,
      });
      setProvisionBundle(bundle);

      // Attempt to render QR code for bundle
      try {
        const qr = await invoke<string>("render_qr_code", {
          data: JSON.stringify(bundle),
        });
        setQrDataUrl(qr);
      } catch (qrErr) {
        // Fallback if QR generator is offline or bundle exceeds raw deep link capacity
        console.warn("Could not generate QR code via render_qr_code:", qrErr);
      }
    } catch (err) {
      setModalError(String(err));
    } finally {
      setProvisionLoading(false);
    }
  };

  const handleCloseProvisionModal = () => {
    setSelectedDep(null);
    setProvisionBundle(null);
    setQrDataUrl(null);
    setBundleCopied(false);
    setModalError(null);
  };

  const handleCopyBundle = async () => {
    if (!provisionBundle) return;
    const bundleText = JSON.stringify(provisionBundle, null, 2);
    try {
      await writeText(bundleText);
      setBundleCopied(true);
      setTimeout(() => setBundleCopied(false), 2500);
    } catch {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(bundleText);
        setBundleCopied(true);
        setTimeout(() => setBundleCopied(false), 2500);
      }
    }
  };

  const handleCreateDependent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      setAddError("Please enter a name for the dependent.");
      return;
    }

    setAddLoading(true);
    setAddError(null);
    try {
      await invoke("create_dependent_profile", {
        name: newName.trim(),
        birthYear: Number(newBirthYear),
        custodyStage: Number(newCustodyStage),
      });
      setShowAddModal(false);
      setNewName("");
      setNewBirthYear(new Date().getFullYear() - 10);
      setNewCustodyStage(1);
      await loadDependents();
    } catch (err) {
      setAddError(String(err));
    } finally {
      setAddLoading(false);
    }
  };

  const handleEmancipate = async (dep: DependentProfile) => {
    if (armEmancipateId !== dep.dependent_id) {
      setArmEmancipateId(dep.dependent_id);
      return;
    }
    setArmEmancipateId(null);
    setEmancipateLoading(true);
    setError(null);
    try {
      const bundle = await invoke<DependentProvisioningBundle>("graduate_dependent_to_sovereign", {
        dependentId: dep.dependent_id,
      });
      setEmancipateSuccessMsg(`🎓 ${dep.name} has graduated to sovereign status.`);
      setTimeout(() => setEmancipateSuccessMsg(null), 5000);
      await loadDependents();
      setSelectedDep(dep);
      setProvisionBundle(bundle);
      try {
        const qr = await invoke<string>("render_qr_code", {
          data: JSON.stringify(bundle),
        });
        setQrDataUrl(qr);
      } catch {}
    } catch (err: any) {
      setError(`Emancipation failed: ${err.toString()}`);
    } finally {
      setEmancipateLoading(false);
    }
  };

  const pillStyle = (stage: number): React.CSSProperties => {
    if (stage === 1) {
      return {
        background: "#ffedd5",
        color: "#9a3412",
        border: "1px solid #fed7aa",
        borderRadius: "999px",
        padding: "2px 10px",
        fontSize: "0.75rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
      };
    }
    if (stage === 2) {
      return {
        background: "#dbeafe",
        color: "#1e40af",
        border: "1px solid #93c5fd",
        borderRadius: "999px",
        padding: "2px 10px",
        fontSize: "0.75rem",
        fontWeight: 600,
        whiteSpace: "nowrap",
      };
    }
    return {
      background: "#dcfce7",
      color: "#166534",
      border: "1px solid #86efac",
      borderRadius: "999px",
      padding: "2px 10px",
      fontSize: "0.75rem",
      fontWeight: 600,
      whiteSpace: "nowrap",
    };
  };

  return (
    <div className="section" data-testid="dependents-manager-section" style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h3 style={{ margin: 0 }}>
            {"\uD83D\uDC68\u200D\uD83D\uDC67\u200D\uD83D\uDC66"} Stewarded Dependent Accounts
          </h3>
          <p className="muted" style={{ margin: "0.35rem 0 0 0", fontSize: "0.83rem" }}>
            Deterministic child profiles derived at <code>m/iyou/dependent/&lt;index&gt;</code>.
            Re-display device provisioning bundles and leaf QR codes anytime without touching the parent root seed.
          </p>
        </div>
        <button
          data-testid="add-dependent-btn"
          onClick={() => {
            setAddError(null);
            setShowAddModal(true);
          }}
          className="btn-primary bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg shadow-sm transition-colors"
          style={{ fontSize: "0.85rem", padding: "0.4rem 0.85rem" }}
        >
          + Add Dependent
        </button>
      </div>

      {error && (
        <div className="error-message" style={{ marginTop: "0.75rem" }}>
          {error}
        </div>
      )}

      {emancipateSuccessMsg && (
        <div
          data-testid="emancipate-success-message"
          style={{
            marginTop: "0.75rem",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#166534",
            padding: "0.5rem 0.75rem",
            borderRadius: "6px",
            fontSize: "0.85rem",
            fontWeight: 500,
          }}
        >
          {emancipateSuccessMsg}
        </div>
      )}

      {loading ? (
        <p className="muted" style={{ marginTop: "1rem" }}>
          Loading saved dependent profiles…
        </p>
      ) : dependents.length === 0 ? (
        <div
          data-testid="dependents-empty"
          style={{
            marginTop: "1rem",
            padding: "1.5rem",
            textAlign: "center",
            background: "var(--color-bg-secondary, #f8fafc)",
            border: "1px dashed var(--color-border, #cbd5e1)",
            borderRadius: "8px",
            color: "var(--color-text-secondary, #64748b)",
          }}
        >
          <div style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>{"\uD83D\uDC6A"}</div>
          <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--color-text, #0f172a)" }}>
            No saved dependent accounts found
          </div>
          <p style={{ margin: "0.35rem auto 0 auto", maxWidth: 450, fontSize: "0.82rem" }}>
            Add a dependent profile above to derive a leaf identity, establish an age-bracket verifiable credential, and provision a child device.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.85rem", marginTop: "1rem" }}>
          {dependents.map((dep) => {
            const ageBracket = getAgeBracketLabel(dep.birth_year, dep.custody_stage);
            const stageLabel = getCustodyStageLabel(dep.custody_stage);

            return (
              <div
                key={dep.dependent_id}
                data-testid={`dependent-card-${dep.dependent_id}`}
                style={{
                  border: "1px solid var(--color-border, #e2e8f0)",
                  borderRadius: "8px",
                  padding: "0.9rem 1.15rem",
                  background: "var(--color-bg-secondary, #f8fafc)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.85rem",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                    <span
                      data-testid={`dependent-name-${dep.dependent_id}`}
                      style={{ fontWeight: 600, fontSize: "1rem", color: "var(--color-text, #0f172a)" }}
                    >
                      {dep.name}
                    </span>
                    <span
                      data-testid={`dependent-bracket-${dep.dependent_id}`}
                      style={pillStyle(dep.custody_stage)}
                    >
                      {ageBracket}
                    </span>
                    <span
                      data-testid={`dependent-stage-${dep.dependent_id}`}
                      style={{
                        fontSize: "0.75rem",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        background: "var(--color-bg-tertiary, #e2e8f0)",
                        color: "var(--color-text-secondary, #475569)",
                      }}
                    >
                      {stageLabel}
                    </span>
                    {dep.revoked && (
                      <span
                        style={{
                          background: "#fee2e2",
                          color: "#991b1b",
                          border: "1px solid #fca5a5",
                          borderRadius: "999px",
                          padding: "2px 8px",
                          fontSize: "0.72rem",
                          fontWeight: 600,
                        }}
                      >
                        Revoked
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <code
                      className="did-display"
                      style={{ fontSize: "0.72rem", fontFamily: "monospace", color: "var(--color-text-secondary, #64748b)" }}
                      title={dep.did}
                    >
                      {shortDid(dep.did)}
                    </code>
                    <span style={{ fontSize: "0.72rem", color: "var(--color-text-tertiary, #94a3b8)" }}>
                      · Born {dep.birth_year}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                  {/* Emancipation Guard: strictly renders on individual dependent when age >= 18 */}
                  {new Date().getFullYear() - dep.birth_year >= 18 && !dep.revoked && dep.custody_stage !== 3 && (
                    <button
                      type="button"
                      data-testid={`dependent-emancipate-${dep.dependent_id}`}
                      onClick={() => handleEmancipate(dep)}
                      disabled={emancipateLoading}
                      className="btn-destructive bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium rounded-lg transition-colors"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.35rem",
                        fontSize: "0.82rem",
                        padding: "0.45rem 0.85rem",
                        borderRadius: "6px",
                        cursor: "pointer",
                        background: armEmancipateId === dep.dependent_id ? "#dc2626" : undefined,
                        color: armEmancipateId === dep.dependent_id ? "#ffffff" : undefined,
                      }}
                    >
                      {armEmancipateId === dep.dependent_id
                        ? "⚠️ Confirm Emancipation"
                        : "Emancipate (18+ / graduate)"}
                    </button>
                  )}

                  {(dep.custody_stage === 3 || dep.graduated_at) && (
                    <span
                      data-testid={`dependent-graduated-badge-${dep.dependent_id}`}
                      style={{
                        background: "#dcfce7",
                        color: "#166534",
                        border: "1px solid #86efac",
                        borderRadius: "999px",
                        padding: "3px 10px",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                      }}
                    >
                      🎓 Sovereign / Graduated
                    </span>
                  )}

                  <button
                    data-testid={`provision-dependent-${dep.dependent_id}`}
                    onClick={() => handleOpenProvision(dep)}
                    disabled={dep.revoked}
                    className="btn-primary bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg shadow-sm transition-colors"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.4rem",
                      fontSize: "0.85rem",
                      padding: "0.45rem 0.9rem",
                      borderRadius: "6px",
                      cursor: dep.revoked ? "not-allowed" : "pointer",
                      opacity: dep.revoked ? 0.6 : 1,
                    }}
                  >
                    <span>{"\uD83D\uDCF1"}</span> Provision Device
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Provisioning Device Modal */}
      {selectedDep && (
        <div
          data-testid="provision-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.55)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={handleCloseProvisionModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="provision-modal-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#ffffff",
              color: "#0f172a",
              borderRadius: "12px",
              padding: "1.75rem",
              maxWidth: 580,
              width: "92%",
              maxHeight: "90vh",
              overflowY: "auto",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                <span style={{ fontSize: "1.5rem" }}>{"\uD83D\uDCF1"}</span>
                <h3 id="provision-modal-title" style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>
                  Device Provisioning: {selectedDep.name}
                </h3>
              </div>
              <button
                type="button"
                data-testid="close-provisioning-modal"
                onClick={handleCloseProvisionModal}
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: "1.2rem",
                  cursor: "pointer",
                  color: "#64748b",
                  padding: "0.2rem 0.5rem",
                }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: "0.85rem", color: "#475569", marginTop: 0, lineHeight: 1.5 }}>
              This leaf provisioning bundle contains the deterministically derived child Ed25519 signing keys, Nostr keys, and age-bracket verifiable credential. Your master parent seed is isolated and never exposed.
            </p>

            {modalError && (
              <div className="error-message" style={{ margin: "1rem 0" }}>
                {modalError}
              </div>
            )}

            {provisionLoading ? (
              <div style={{ textAlign: "center", padding: "2rem" }}>
                <p className="muted">Deriving leaf bundle &amp; generating QR code…</p>
              </div>
            ) : provisionBundle ? (
              <div>
                {/* QR Code Presentation */}
                {qrDataUrl ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      padding: "1.25rem",
                      background: "#f8fafc",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                      marginBottom: "1rem",
                    }}
                  >
                    <img
                      data-testid="provisioning-qr-image"
                      src={qrDataUrl}
                      alt={`Provisioning QR Code for ${selectedDep.name}`}
                      style={{
                        width: "210px",
                        height: "210px",
                        display: "block",
                        borderRadius: "4px",
                      }}
                    />
                    <div
                      data-testid="provisioning-qr-hint"
                      style={{
                        fontSize: "0.75rem",
                        color: "#64748b",
                        marginTop: "0.75rem",
                        textAlign: "center",
                      }}
                    >
                      Scan this QR code with <code>iyou_mobile</code> or the child client to import credentials.
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "1rem",
                      background: "#f1f5f9",
                      borderRadius: "6px",
                      marginBottom: "1rem",
                      fontSize: "0.8rem",
                      color: "#475569",
                      textAlign: "center",
                    }}
                  >
                    QR preview unavailable. You can copy the leaf provisioning bundle JSON directly below.
                  </div>
                )}

                {/* Provisioning Bundle JSON */}
                <div style={{ marginBottom: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.35rem" }}>
                    <label style={{ fontSize: "0.78rem", fontWeight: 600, color: "#334155" }}>
                      Leaf Provisioning Bundle JSON:
                    </label>
                    <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
                      Derived at index #{provisionBundle.custody_stage} · v{provisionBundle.bundle_version}
                    </span>
                  </div>
                  <textarea
                    data-testid="provisioning-bundle-json"
                    readOnly
                    value={JSON.stringify(provisionBundle, null, 2)}
                    rows={8}
                    style={{
                      width: "100%",
                      fontFamily: "monospace",
                      fontSize: "0.72rem",
                      padding: "0.6rem",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      background: "#f8fafc",
                      color: "#1e293b",
                      boxSizing: "border-box",
                      resize: "vertical",
                    }}
                  />
                </div>

                <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    data-testid="copy-provisioning-bundle"
                    onClick={handleCopyBundle}
                    style={{
                      padding: "0.5rem 1.1rem",
                      fontSize: "0.85rem",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: "0.35rem",
                    }}
                  >
                    <span>{bundleCopied ? "\u2713" : "\uD83D\uDCCB"}</span>
                    {bundleCopied ? "Copied!" : "Copy Bundle"}
                  </button>
                  <button
                    type="button"
                    onClick={handleCloseProvisionModal}
                    style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }}
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Add Dependent Modal */}
      {showAddModal && (
        <div
          data-testid="add-dependent-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.55)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowAddModal(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-dependent-modal-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#ffffff",
              color: "#0f172a",
              borderRadius: "12px",
              padding: "1.75rem",
              maxWidth: 480,
              width: "92%",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
            }}
          >
            <h3 id="add-dependent-modal-title" style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem" }}>
              + Add Stewarded Dependent Account
            </h3>
            <p style={{ fontSize: "0.82rem", color: "#64748b", margin: "0 0 1.25rem 0" }}>
              Derives a child leaf identity under deterministic path <code>m/iyou/dependent/&lt;index&gt;</code> and issues an age-bracket VC.
            </p>

            {addError && (
              <div className="error-message" style={{ marginBottom: "1rem" }}>
                {addError}
              </div>
            )}

            <form onSubmit={handleCreateDependent}>
              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.35rem" }}>
                  Dependent Name / Petname:
                </label>
                <input
                  type="text"
                  data-testid="dependent-name-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Violette"
                  required
                  style={{
                    width: "100%",
                    padding: "0.55rem 0.75rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "0.88rem",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.35rem" }}>
                  Birth Year:
                </label>
                <input
                  type="number"
                  data-testid="dependent-birthyear-input"
                  value={newBirthYear}
                  onChange={(e) => setNewBirthYear(parseInt(e.target.value, 10))}
                  min={1990}
                  max={new Date().getFullYear()}
                  required
                  style={{
                    width: "100%",
                    padding: "0.55rem 0.75rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "0.88rem",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              <div style={{ marginBottom: "1.5rem" }}>
                <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, marginBottom: "0.35rem" }}>
                  Custody Stage:
                </label>
                <select
                  data-testid="dependent-custody-select"
                  value={newCustodyStage}
                  onChange={(e) => setNewCustodyStage(Number(e.target.value) as 1 | 2)}
                  style={{
                    width: "100%",
                    padding: "0.55rem 0.75rem",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "0.88rem",
                    boxSizing: "border-box",
                  }}
                >
                  <option value={1}>Stage 1: Guided Delegation (&lt;13 years old)</option>
                  <option value={2}>Stage 2: Autonomous (13–17 years old)</option>
                </select>
              </div>

              <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  data-testid="cancel-create-dependent"
                  onClick={() => setShowAddModal(false)}
                  style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  data-testid="submit-create-dependent"
                  disabled={addLoading}
                  style={{ padding: "0.5rem 1.25rem", fontSize: "0.85rem", fontWeight: 600 }}
                >
                  {addLoading ? "Deriving…" : "Create Dependent"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
