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
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Profile, RoleProfile, BusinessProfile } from "../../lib/types";

interface PersonaMatrixProps {
  profiles: Profile[];
  activeDid: string | null;
  onRefresh: () => void | Promise<void>;
  onSetActiveProfile?: (profile: Profile | null) => void;
  roles?: RoleProfile[];
  businesses?: BusinessProfile[];
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
  onSetActiveProfile,
  roles: initialRoles,
  businesses: initialBusinesses,
}: PersonaMatrixProps) {
  const [newPersonaName, setNewPersonaName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [anchorWarningOpen, setAnchorWarningOpen] = useState<"did" | "hex" | null>(null);
  const [anchorCopiedLabel, setAnchorCopiedLabel] = useState<string | null>(null);
  const [showAnchorDid, setShowAnchorDid] = useState<boolean>(false);
  const [showAnchorHex, setShowAnchorHex] = useState<boolean>(false);
  const [breakGlassModalOpen, setBreakGlassModalOpen] = useState<boolean>(false);
  const [rotationConfirmText, setRotationConfirmText] = useState<string>("");
  const [rotationInProgress, setRotationInProgress] = useState<boolean>(false);

  // Accordion state: Level 0 collapsed by default for zero shoulder-surfing exposure
  const [expandedTiers, setExpandedTiers] = useState<Record<string, boolean>>({
    level0: false,
    level1: true,
    level2: true,
    level3: true,
    level4: true,
  });

  const toggleTier = (tier: string) => {
    setExpandedTiers((prev) => ({
      ...prev,
      [tier]: !prev[tier],
    }));
  };

  // Level 3 (Roles) & Level 4 (Businesses) state
  const [roles, setRoles] = useState<RoleProfile[]>(initialRoles || []);
  const [businesses, setBusinesses] = useState<BusinessProfile[]>(initialBusinesses || []);

  const [isCreatingRole, setIsCreatingRole] = useState(false);
  const [showCreateRoleForm, setShowCreateRoleForm] = useState(false);
  const [newRoleTitle, setNewRoleTitle] = useState("");
  const [newRoleNamespace, setNewRoleNamespace] = useState("");
  const [newRoleOrgDid, setNewRoleOrgDid] = useState("");
  const [newRoleDelegationScope, setNewRoleDelegationScope] = useState("");
  const [newRoleAccreditationVcId, setNewRoleAccreditationVcId] = useState("");

  const [isCreatingBusiness, setIsCreatingBusiness] = useState(false);
  const [showCreateBusinessForm, setShowCreateBusinessForm] = useState(false);
  const [newBusinessLegalName, setNewBusinessLegalName] = useState("");
  const [newBusinessJurisdiction, setNewBusinessJurisdiction] = useState("");
  const [newBusinessRegistrationNumber, setNewBusinessRegistrationNumber] = useState("");
  const [newBusinessCurrency, setNewBusinessCurrency] = useState("USD");
  const [newBusinessMerchantEndpoints, setNewBusinessMerchantEndpoints] = useState("");

  const loadRolesAndBusinesses = async () => {
    try {
      const r = await invoke<RoleProfile[]>("list_roles");
      setRoles(r || []);
    } catch (e) {
      console.warn("Failed to fetch roles:", e);
    }
    try {
      const b = await invoke<BusinessProfile[]>("list_businesses");
      setBusinesses(b || []);
    } catch (e) {
      console.warn("Failed to fetch businesses:", e);
    }
  };

  useEffect(() => {
    if (initialRoles) setRoles(initialRoles);
    if (initialBusinesses) setBusinesses(initialBusinesses);
    if (!initialRoles || !initialBusinesses) {
      loadRolesAndBusinesses();
    }
  }, [initialRoles, initialBusinesses]);

  const formatMaskedDid = (did: string): string => {
    if (!did) return "";
    const prefix = did.slice(0, 12);
    const suffix = did.slice(-4);
    return `${prefix}\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${suffix}`;
  };

  const formatMaskedHex = (hex: string): string => {
    if (!hex) return "";
    return `${hex.slice(0, 8)}\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022${hex.slice(-4)}`;
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
      } catch (e: any) {
        console.error("Clipboard copy failed:", e);
      }
    }
  };

  const handleSetActive = async (profileId: string) => {
    setActionError(null);
    setActionSuccess(null);
    try {
      const selected = profiles.find((p) => p.profile_id === profileId);
      if (selected && onSetActiveProfile) {
        onSetActiveProfile(selected);
      }
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

  const handleCreateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    const slug = newRoleNamespace.trim().toLowerCase();
    if (!slug.match(/^[a-z0-9_-]{1,32}$/)) {
      setActionError(
        "Namespace must be 1 to 32 lowercase alphanumeric characters, dashes, or underscores (e.g. dev-dao, acme_corp)."
      );
      return;
    }
    if (!newRoleTitle.trim()) {
      setActionError("Role title is required.");
      return;
    }
    if (!newRoleOrgDid.trim()) {
      setActionError("Organization DID is required.");
      return;
    }

    setIsCreatingRole(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const delegationScope = newRoleDelegationScope
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      await invoke("create_role_profile", {
        roleTitle: newRoleTitle.trim(),
        namespace: slug,
        organizationDid: newRoleOrgDid.trim(),
        delegationScope: delegationScope.length > 0 ? delegationScope : null,
        accreditationVcId: newRoleAccreditationVcId.trim() || null,
      });

      setNewRoleTitle("");
      setNewRoleNamespace("");
      setNewRoleOrgDid("");
      setNewRoleDelegationScope("");
      setNewRoleAccreditationVcId("");
      setShowCreateRoleForm(false);
      setActionSuccess(`Accredited Role '${newRoleTitle.trim()}' created in namespace '${slug}'`);
      await loadRolesAndBusinesses();
      await onRefresh();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err: any) {
      setActionError(`Failed to create role profile: ${err.toString()}`);
    } finally {
      setIsCreatingRole(false);
    }
  };

  const handleCreateBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBusinessLegalName.trim()) {
      setActionError("Business legal name is required.");
      return;
    }
    if (!newBusinessJurisdiction.trim()) {
      setActionError("Legal jurisdiction is required (e.g. US-DE, UK, SG, CH).");
      return;
    }

    setIsCreatingBusiness(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const bizId =
        newBusinessLegalName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_") ||
        `biz_${Date.now()}`;
      const endpoints = newBusinessMerchantEndpoints
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      await invoke("create_business_profile", {
        businessId: bizId,
        legalName: newBusinessLegalName.trim(),
        jurisdiction: newBusinessJurisdiction.trim(),
        operatingCurrency: newBusinessCurrency.trim() || "USD",
        registrationNumber: newBusinessRegistrationNumber.trim() || null,
        merchantEndpoints: endpoints,
      });

      setNewBusinessLegalName("");
      setNewBusinessJurisdiction("");
      setNewBusinessRegistrationNumber("");
      setNewBusinessCurrency("USD");
      setNewBusinessMerchantEndpoints("");
      setShowCreateBusinessForm(false);
      setActionSuccess(`Business profile '${newBusinessLegalName.trim()}' created successfully`);
      await loadRolesAndBusinesses();
      await onRefresh();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err: any) {
      setActionError(`Failed to create business profile: ${err.toString()}`);
    } finally {
      setIsCreatingBusiness(false);
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

  const level0Profile = profiles.find(
    (p) => p.level === 0 || p.derivation_index === 0,
  );
  const level1Profile = profiles.find(
    (p) => p.level === 1 || p.derivation_index === 1,
  );

  const handleAnchorCopyLevel1 = async () => {
    if (!level1Profile) return;
    if (anchorWarningOpen === "hex" && level1Profile.nostr_pubkey_hex) {
      await copyToClipboard(level1Profile.nostr_pubkey_hex, "anchor-shield-level1-hex");
      setAnchorCopiedLabel("level1-hex");
    } else {
      await copyToClipboard(level1Profile.did, "anchor-shield-level1-did");
      setAnchorCopiedLabel("level1-did");
    }
    setTimeout(() => {
      setAnchorCopiedLabel(null);
      setAnchorWarningOpen(null);
    }, 1500);
  };

  const handleAnchorCopyLevel0 = async () => {
    if (!level0Profile) return;
    if (anchorWarningOpen === "hex" && level0Profile.nostr_pubkey_hex) {
      await copyToClipboard(level0Profile.nostr_pubkey_hex, "anchor-shield-level0-hex");
      setAnchorCopiedLabel("level0-hex");
    } else {
      await copyToClipboard(level0Profile.did, "anchor-shield-level0-did");
      setAnchorCopiedLabel("level0-did");
    }
    setTimeout(() => {
      setAnchorCopiedLabel(null);
      setAnchorWarningOpen(null);
    }, 1500);
  };

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

      {/* Trust Tier Quick-Toggle Bar */}
      <div className="trust-tier-bar" style={{ marginBottom: "1.25rem" }}>
        <div
          className={`trust-tier-card ${expandedTiers.level0 ? "active" : ""}`}
          onClick={() => toggleTier("level0")}
          title="Toggle Level 0 — Anchor Sanctum"
          role="button"
          tabIndex={0}
        >
          <div className="trust-tier-label">L0 • Anchor</div>
          <div className="trust-tier-count">
            {anchorProfiles.length}
            <span style={{ fontSize: "0.75rem", marginLeft: "0.35rem", opacity: 0.7 }}>
              {expandedTiers.level0 ? "▼" : "▶"}
            </span>
          </div>
        </div>

        <div
          className={`trust-tier-card level-1 ${expandedTiers.level1 ? "active" : ""}`}
          onClick={() => toggleTier("level1")}
          title="Toggle Level 1 — Primary Identity"
          role="button"
          tabIndex={0}
        >
          <div className="trust-tier-label">L1 • Primary</div>
          <div className="trust-tier-count">
            {primaryProfiles.length}
            <span style={{ fontSize: "0.75rem", marginLeft: "0.35rem", opacity: 0.7 }}>
              {expandedTiers.level1 ? "▼" : "▶"}
            </span>
          </div>
        </div>

        <div
          className={`trust-tier-card level-2 ${expandedTiers.level2 ? "active" : ""}`}
          onClick={() => toggleTier("level2")}
          title="Toggle Level 2 — Contextual / Burner Personas"
          role="button"
          tabIndex={0}
        >
          <div className="trust-tier-label">L2 • Burners</div>
          <div className="trust-tier-count">
            {burnerProfiles.length}
            <span style={{ fontSize: "0.75rem", marginLeft: "0.35rem", opacity: 0.7 }}>
              {expandedTiers.level2 ? "▼" : "▶"}
            </span>
          </div>
        </div>

        <div
          className={`trust-tier-card level-3 ${expandedTiers.level3 ? "active" : ""}`}
          onClick={() => toggleTier("level3")}
          title="Toggle Level 3 — Accredited Roles & Collectives"
          role="button"
          tabIndex={0}
        >
          <div className="trust-tier-label">L3 • Roles</div>
          <div className="trust-tier-count">
            {roles.length}
            <span style={{ fontSize: "0.75rem", marginLeft: "0.35rem", opacity: 0.7 }}>
              {expandedTiers.level3 ? "▼" : "▶"}
            </span>
          </div>
        </div>

        <div
          className={`trust-tier-card level-4 ${expandedTiers.level4 ? "active" : ""}`}
          onClick={() => toggleTier("level4")}
          title="Toggle Level 4 — Business & Commerce Profiles"
          role="button"
          tabIndex={0}
        >
          <div className="trust-tier-label">L4 • Commerce</div>
          <div className="trust-tier-count">
            {businesses.length}
            <span style={{ fontSize: "0.75rem", marginLeft: "0.35rem", opacity: 0.7 }}>
              {expandedTiers.level4 ? "▼" : "▶"}
            </span>
          </div>
        </div>
      </div>

      {/* Level 0: Anchor Sanctum */}
      <div
        className="section"
        style={{
          borderLeft: "4px solid #7c3aed",
          background: "rgba(124, 58, 237, 0.04)",
        }}
      >
        <div
          onClick={() => toggleTier("level0")}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
            cursor: "pointer",
            userSelect: "none",
          }}
          role="button"
          tabIndex={0}
          aria-expanded={expandedTiers.level0}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1rem", color: "#7c3aed", fontWeight: "bold" }}>
              {expandedTiers.level0 ? "▼" : "▶"}
            </span>
            <span style={{ fontSize: "1.3rem" }}>🛡️🔒</span>
            <h3 style={{ margin: 0, color: "#7c3aed" }}>
              Level 0 — Anchor Sanctum (Air-Gapped Root)
            </h3>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {!expandedTiers.level0 && (
              <span
                style={{
                  background: "#f3e8ff",
                  color: "#7e22ce",
                  padding: "0.2rem 0.6rem",
                  borderRadius: "12px",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  border: "1px solid #e9d5ff",
                }}
              >
                Shielded Root — Tap to Expand
              </span>
            )}
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
        </div>

        {expandedTiers.level0 && (
          <div style={{ marginTop: "0.75rem" }}>
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
                <span>{showAnchorDid ? p.did : formatMaskedDid(p.did)}</span>
                <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", marginLeft: "0.5rem", flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setShowAnchorDid(!showAnchorDid)}
                    style={{
                      padding: "0.2rem 0.35rem",
                      fontSize: "0.85rem",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      lineHeight: 1,
                    }}
                    title={showAnchorDid ? "Hide Anchor DID" : "Reveal Anchor DID"}
                  >
                    {showAnchorDid ? "🙈" : "👁️"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnchorWarningOpen("did")}
                    style={{
                      padding: "0.2rem 0.5rem",
                      fontSize: "0.75rem",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {anchorCopiedLabel === "level0-did" || anchorCopiedLabel === "level1-did"
                      ? "✓ Copied"
                      : "📋 Copy"}
                  </button>
                </div>
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
                  <span>{showAnchorHex ? p.nostr_pubkey_hex : formatMaskedHex(p.nostr_pubkey_hex)}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", marginLeft: "0.5rem", flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => setShowAnchorHex(!showAnchorHex)}
                      style={{
                        padding: "0.2rem 0.35rem",
                        fontSize: "0.85rem",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        lineHeight: 1,
                      }}
                      title={showAnchorHex ? "Hide Anchor Hex" : "Reveal Anchor Hex"}
                    >
                      {showAnchorHex ? "🙈" : "👁️"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAnchorWarningOpen("hex")}
                      style={{
                        padding: "0.2rem 0.5rem",
                        fontSize: "0.75rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {anchorCopiedLabel === "level0-hex" || anchorCopiedLabel === "level1-hex"
                        ? "✓ Copied"
                        : "📋 Copy"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
          </div>
        )}
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
          onClick={() => toggleTier("level1")}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
            cursor: "pointer",
            userSelect: "none",
          }}
          role="button"
          tabIndex={0}
          aria-expanded={expandedTiers.level1}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1rem", color: "#2563eb", fontWeight: "bold" }}>
              {expandedTiers.level1 ? "▼" : "▶"}
            </span>
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

        {expandedTiers.level1 && (
          <div style={{ marginTop: "0.75rem" }}>
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
                {isActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setRotationConfirmText("");
                      setBreakGlassModalOpen(true);
                    }}
                    style={{
                      padding: "0.25rem 0.6rem",
                      fontSize: "0.75rem",
                      background: "transparent",
                      border: "1px solid rgba(239,68,68,0.4)",
                      color: "#dc2626",
                      borderRadius: "4px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    🚨 Break-Glass
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
        )}
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
          onClick={() => toggleTier("level2")}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
            cursor: "pointer",
            userSelect: "none",
          }}
          role="button"
          tabIndex={0}
          aria-expanded={expandedTiers.level2}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1rem", color: "#059669", fontWeight: "bold" }}>
              {expandedTiers.level2 ? "▼" : "▶"}
            </span>
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

        {expandedTiers.level2 && (
          <div style={{ marginTop: "0.75rem" }}>
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
        )}
      </div>

      {/* Level 3: Accredited Roles & Collectives */}
      <div
        className="section"
        style={{
          borderLeft: "4px solid #d97706",
          background: "rgba(217, 119, 6, 0.03)",
        }}
      >
        <div
          onClick={() => toggleTier("level3")}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
            cursor: "pointer",
            userSelect: "none",
          }}
          role="button"
          tabIndex={0}
          aria-expanded={expandedTiers.level3}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1rem", color: "#d97706", fontWeight: "bold" }}>
              {expandedTiers.level3 ? "▼" : "▶"}
            </span>
            <span style={{ fontSize: "1.3rem" }}>🏛️📜</span>
            <h3 style={{ margin: 0, color: "#d97706" }}>
              Level 3 — Accredited Roles & Collectives ({roles.length})
            </h3>
          </div>
          <span
            style={{
              background: "#fef3c7",
              color: "#92400e",
              padding: "0.2rem 0.6rem",
              borderRadius: "12px",
              fontSize: "0.75rem",
              fontWeight: 700,
              border: "1px solid #fde68a",
            }}
          >
            Accredited Role Isolation
          </span>
        </div>

        {expandedTiers.level3 && (
          <div style={{ marginTop: "0.75rem" }}>
            <p style={{ fontSize: "0.85rem", color: "#4b5563", margin: "0.5rem 0 0.75rem" }}>
              Accredited organizational roles, collective delegations, and DAO authority paths.
              Derived deterministically under isolated namespace derivation subtrees.
            </p>

            <div
              style={{
                background: "#fffbeb",
                color: "#92400e",
                padding: "0.6rem 0.85rem",
                borderRadius: "6px",
                margin: "0.75rem 0",
                fontSize: "0.85rem",
                border: "1px solid #fde68a",
                lineHeight: "1.4",
              }}
            >
              🔒 <strong>Fail-Closed Security Notice:</strong> Level 3 identities are isolated from public social feeds and dApp bridges. WebSocket bridge signing requests for Level 3 profiles are rejected by default.
            </div>

            {/* Toggle create role form */}
            <div style={{ margin: "1rem 0" }}>
              {!showCreateRoleForm ? (
                <button
                  onClick={() => setShowCreateRoleForm(true)}
                  style={{
                    padding: "0.5rem 1rem",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    borderRadius: "6px",
                    background: "#fef3c7",
                    color: "#b45309",
                    border: "1px solid #fcd34d",
                    cursor: "pointer",
                  }}
                >
                  + Create Accredited Role Profile
                </button>
              ) : (
                <form
                  onSubmit={handleCreateRole}
                  style={{
                    background: "white",
                    padding: "1rem",
                    borderRadius: "8px",
                    border: "1px solid #fde68a",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h4 style={{ margin: 0, color: "#92400e", fontSize: "0.95rem" }}>
                      New Accredited Role Profile
                    </h4>
                    <button
                      type="button"
                      onClick={() => setShowCreateRoleForm(false)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#9ca3af",
                        cursor: "pointer",
                        fontSize: "1rem",
                      }}
                    >
                      ✕
                    </button>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Role Title *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Treasury Signer, Lead Auditor, Guild Steward"
                      value={newRoleTitle}
                      onChange={(e) => setNewRoleTitle(e.target.value)}
                      required
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Namespace (Slug: a-z, 0-9, -, _) *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. dev-dao, acme_corp, open-syndicate"
                      value={newRoleNamespace}
                      onChange={(e) => setNewRoleNamespace(e.target.value.toLowerCase())}
                      pattern="^[a-z0-9_-]{1,32}$"
                      title="1 to 32 lowercase alphanumeric characters, dashes, or underscores"
                      required
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                        fontFamily: "monospace",
                      }}
                    />
                    <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                      Subtree derivation path: iyou/role/{newRoleNamespace || "<namespace>"}/[index]
                    </span>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Organization DID *
                    </label>
                    <input
                      type="text"
                      placeholder="did:key:... or did:ion:..."
                      value={newRoleOrgDid}
                      onChange={(e) => setNewRoleOrgDid(e.target.value)}
                      required
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                        fontFamily: "monospace",
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Delegation Scope (Optional, comma-separated)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. sign_proposals, approve_transfers, audit_logs"
                      value={newRoleDelegationScope}
                      onChange={(e) => setNewRoleDelegationScope(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Accreditation VC ID (Optional)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. urn:uuid:... or VC credential ID"
                      value={newRoleAccreditationVcId}
                      onChange={(e) => setNewRoleAccreditationVcId(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                        fontFamily: "monospace",
                      }}
                    />
                  </div>

                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                    <button
                      type="submit"
                      disabled={isCreatingRole}
                      style={{
                        padding: "0.5rem 1rem",
                        borderRadius: "6px",
                        background: "#d97706",
                        color: "white",
                        border: "none",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {isCreatingRole ? "Deriving Role Key..." : "Create Role Profile"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCreateRoleForm(false)}
                      style={{
                        padding: "0.5rem 1rem",
                        borderRadius: "6px",
                        background: "#e5e7eb",
                        color: "#374151",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* List Roles */}
            {roles.length === 0 ? (
              <div
                style={{
                  padding: "1.5rem",
                  textAlign: "center",
                  background: "white",
                  borderRadius: "8px",
                  border: "1px dashed #d1d5db",
                  color: "#6b7280",
                  fontSize: "0.85rem",
                }}
              >
                No Level 3 Accredited Roles provisioned yet. Use the button above to add a role identity bound to an organization.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {roles.map((r) => {
                  const isActive = r.did === activeDid;
                  return (
                    <div
                      key={r.role_id}
                      style={{
                        padding: "0.85rem",
                        borderRadius: "8px",
                        background: isActive ? "#fffbeb" : "white",
                        border: isActive ? "1px solid #d97706" : "1px solid #e5e7eb",
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
                          <span style={{ fontWeight: 600, color: "#111827", fontSize: "0.95rem" }}>
                            {r.role_title}
                          </span>
                          <span
                            style={{
                              background: "#fef3c7",
                              color: "#b45309",
                              padding: "0.15rem 0.5rem",
                              borderRadius: "6px",
                              fontSize: "0.75rem",
                              fontWeight: 700,
                              border: "1px solid #fde68a",
                              fontFamily: "monospace",
                            }}
                          >
                            ns:{r.namespace} #{r.role_index}
                          </span>
                          <span
                            style={{
                              background: "#f3f4f6",
                              color: "#4b5563",
                              padding: "0.15rem 0.4rem",
                              borderRadius: "4px",
                              fontSize: "0.7rem",
                              fontWeight: 600,
                            }}
                          >
                            L3
                          </span>
                          {isActive && (
                            <span
                              style={{
                                background: "#dcfce7",
                                color: "#15803d",
                                padding: "0.15rem 0.4rem",
                                borderRadius: "4px",
                                fontSize: "0.7rem",
                                fontWeight: 700,
                              }}
                            >
                              ● ACTIVE
                            </span>
                          )}
                        </div>

                        <div style={{ display: "flex", gap: "0.4rem" }}>
                          <button
                            onClick={() => copyToClipboard(r.did, `role-did-${r.role_id}`)}
                            style={{
                              padding: "0.25rem 0.6rem",
                              fontSize: "0.75rem",
                              borderRadius: "4px",
                              border: "1px solid #d1d5db",
                              background: "white",
                              cursor: "pointer",
                            }}
                          >
                            {copiedKey === `role-did-${r.role_id}` ? "✓ Copied DID" : "📋 Copy DID"}
                          </button>
                          <button
                            onClick={() => copyToClipboard(r.nostr_pubkey_hex, `role-hex-${r.role_id}`)}
                            style={{
                              padding: "0.25rem 0.6rem",
                              fontSize: "0.75rem",
                              borderRadius: "4px",
                              border: "1px solid #d1d5db",
                              background: "white",
                              cursor: "pointer",
                            }}
                          >
                            {copiedKey === `role-hex-${r.role_id}` ? "✓ Copied Hex" : "📋 Copy Key"}
                          </button>
                        </div>
                      </div>

                      <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "#4b5563", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                        <div>
                          <strong>DID:</strong>{" "}
                          <span style={{ fontFamily: "monospace" }}>{truncateString(r.did, 24, 10)}</span>
                        </div>
                        <div>
                          <strong>Org DID:</strong>{" "}
                          <span style={{ fontFamily: "monospace" }}>{truncateString(r.organization_did, 24, 10)}</span>
                        </div>
                        <div>
                          <strong>Nostr Key:</strong>{" "}
                          <span style={{ fontFamily: "monospace" }}>{truncateString(r.nostr_pubkey_hex, 16, 8)}</span>
                        </div>
                        {r.delegation_scope && r.delegation_scope.length > 0 && (
                          <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginTop: "0.2rem" }}>
                            <strong>Scopes:</strong>
                            {r.delegation_scope.map((s, idx) => (
                              <span
                                key={idx}
                                style={{
                                  background: "#fef9c3",
                                  color: "#854d0e",
                                  padding: "0.1rem 0.4rem",
                                  borderRadius: "4px",
                                  fontSize: "0.7rem",
                                }}
                              >
                                {s}
                              </span>
                            ))}
                          </div>
                        )}
                        {r.accreditation_vc_id && (
                          <div>
                            <strong>VC Credential:</strong>{" "}
                            <span style={{ fontFamily: "monospace", fontSize: "0.75rem" }}>{r.accreditation_vc_id}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Level 4: Business & Commerce Profiles */}
      <div
        className="section"
        style={{
          borderLeft: "4px solid #0891b2",
          background: "rgba(8, 145, 178, 0.03)",
        }}
      >
        <div
          onClick={() => toggleTier("level4")}
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.5rem",
            cursor: "pointer",
            userSelect: "none",
          }}
          role="button"
          tabIndex={0}
          aria-expanded={expandedTiers.level4}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1rem", color: "#0891b2", fontWeight: "bold" }}>
              {expandedTiers.level4 ? "▼" : "▶"}
            </span>
            <span style={{ fontSize: "1.3rem" }}>🏢💼</span>
            <h3 style={{ margin: 0, color: "#0891b2" }}>
              Level 4 — Business & Commerce Profiles ({businesses.length})
            </h3>
          </div>
          <span
            style={{
              background: "#cffafe",
              color: "#0e7490",
              padding: "0.2rem 0.6rem",
              borderRadius: "12px",
              fontSize: "0.75rem",
              fontWeight: 700,
              border: "1px solid #a5f3fc",
            }}
          >
            Commercial Isolation
          </span>
        </div>

        {expandedTiers.level4 && (
          <div style={{ marginTop: "0.75rem" }}>
            <p style={{ fontSize: "0.85rem", color: "#4b5563", margin: "0.5rem 0 0.75rem" }}>
              Commercial entities, merchant profiles, and corporate identities with legally registered jurisdictions.
            </p>

            <div
              style={{
                background: "#ecfeff",
                color: "#155e75",
                padding: "0.6rem 0.85rem",
                borderRadius: "6px",
                margin: "0.75rem 0",
                fontSize: "0.85rem",
                border: "1px solid #a5f3fc",
                lineHeight: "1.4",
              }}
            >
              🔒 <strong>Commercial Boundary:</strong> Level 4 identities operate under commercial isolation. Bridge access denied to prevent cross-contamination with personal and social keys.
            </div>

            {/* Toggle create business form */}
            <div style={{ margin: "1rem 0" }}>
              {!showCreateBusinessForm ? (
                <button
                  onClick={() => setShowCreateBusinessForm(true)}
                  style={{
                    padding: "0.5rem 1rem",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    borderRadius: "6px",
                    background: "#cffafe",
                    color: "#0e7490",
                    border: "1px solid #67e8f9",
                    cursor: "pointer",
                  }}
                >
                  + Create Business Profile
                </button>
              ) : (
                <form
                  onSubmit={handleCreateBusiness}
                  style={{
                    background: "white",
                    padding: "1rem",
                    borderRadius: "8px",
                    border: "1px solid #a5f3fc",
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h4 style={{ margin: 0, color: "#0e7490", fontSize: "0.95rem" }}>
                      New Business & Commerce Profile
                    </h4>
                    <button
                      type="button"
                      onClick={() => setShowCreateBusinessForm(false)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#9ca3af",
                        cursor: "pointer",
                        fontSize: "1rem",
                      }}
                    >
                      ✕
                    </button>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Business Legal Name *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Acme Corp LLC, Satoshi Enterprises Ltd"
                      value={newBusinessLegalName}
                      onChange={(e) => setNewBusinessLegalName(e.target.value)}
                      required
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Legal Jurisdiction *
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. US-DE, UK, SG, CH, EE"
                      value={newBusinessJurisdiction}
                      onChange={(e) => setNewBusinessJurisdiction(e.target.value)}
                      required
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Registration / Tax Number (Optional)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. EIN, VAT, LEI, Company Number"
                      value={newBusinessRegistrationNumber}
                      onChange={(e) => setNewBusinessRegistrationNumber(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Operating Currency (Default: USD)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. USD, EUR, GBP, SAT"
                      value={newBusinessCurrency}
                      onChange={(e) => setNewBusinessCurrency(e.target.value.toUpperCase())}
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, color: "#374151", marginBottom: "0.25rem" }}>
                      Merchant Endpoints (Optional, comma-separated URLs)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. https://store.example.com/api, https://pay.example.com"
                      value={newBusinessMerchantEndpoints}
                      onChange={(e) => setNewBusinessMerchantEndpoints(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "0.5rem",
                        borderRadius: "6px",
                        border: "1px solid #d1d5db",
                        fontSize: "0.85rem",
                      }}
                    />
                  </div>

                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                    <button
                      type="submit"
                      disabled={isCreatingBusiness}
                      style={{
                        padding: "0.5rem 1rem",
                        borderRadius: "6px",
                        background: "#0891b2",
                        color: "white",
                        border: "none",
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      {isCreatingBusiness ? "Deriving Business Key..." : "Create Business Profile"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCreateBusinessForm(false)}
                      style={{
                        padding: "0.5rem 1rem",
                        borderRadius: "6px",
                        background: "#e5e7eb",
                        color: "#374151",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* List Businesses */}
            {businesses.length === 0 ? (
              <div
                style={{
                  padding: "1.5rem",
                  textAlign: "center",
                  background: "white",
                  borderRadius: "8px",
                  border: "1px dashed #d1d5db",
                  color: "#6b7280",
                  fontSize: "0.85rem",
                }}
              >
                No Level 4 Business profiles provisioned yet. Use the button above to register an enterprise identity.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {businesses.map((b) => {
                  return (
                    <div
                      key={b.business_id}
                      style={{
                        padding: "0.85rem",
                        borderRadius: "8px",
                        background: "white",
                        border: "1px solid #e5e7eb",
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
                          <span style={{ fontWeight: 600, color: "#111827", fontSize: "0.95rem" }}>
                            {b.legal_name}
                          </span>
                          <span
                            style={{
                              background: "#cffafe",
                              color: "#0e7490",
                              padding: "0.15rem 0.5rem",
                              borderRadius: "6px",
                              fontSize: "0.75rem",
                              fontWeight: 700,
                              border: "1px solid #a5f3fc",
                            }}
                          >
                            Jurisdiction: {b.jurisdiction}
                          </span>
                          <span
                            style={{
                              background: "#f3f4f6",
                              color: "#4b5563",
                              padding: "0.15rem 0.4rem",
                              borderRadius: "4px",
                              fontSize: "0.7rem",
                              fontWeight: 600,
                            }}
                          >
                            L4 #{b.business_index}
                          </span>
                          <span
                            style={{
                              background: "#f0fdf4",
                              color: "#166534",
                              padding: "0.15rem 0.4rem",
                              borderRadius: "4px",
                              fontSize: "0.7rem",
                              fontWeight: 600,
                              border: "1px solid #bbf7d0",
                            }}
                          >
                            {b.operating_currency}
                          </span>
                        </div>

                        <div style={{ display: "flex", gap: "0.4rem" }}>
                          <button
                            onClick={() => copyToClipboard(b.did, `biz-did-${b.business_id}`)}
                            style={{
                              padding: "0.25rem 0.6rem",
                              fontSize: "0.75rem",
                              borderRadius: "4px",
                              border: "1px solid #d1d5db",
                              background: "white",
                              cursor: "pointer",
                            }}
                          >
                            {copiedKey === `biz-did-${b.business_id}` ? "✓ Copied DID" : "📋 Copy DID"}
                          </button>
                          <button
                            onClick={() => copyToClipboard(b.nostr_pubkey_hex, `biz-hex-${b.business_id}`)}
                            style={{
                              padding: "0.25rem 0.6rem",
                              fontSize: "0.75rem",
                              borderRadius: "4px",
                              border: "1px solid #d1d5db",
                              background: "white",
                              cursor: "pointer",
                            }}
                          >
                            {copiedKey === `biz-hex-${b.business_id}` ? "✓ Copied Hex" : "📋 Copy Key"}
                          </button>
                        </div>
                      </div>

                      <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "#4b5563", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                        <div>
                          <strong>DID:</strong>{" "}
                          <span style={{ fontFamily: "monospace" }}>{truncateString(b.did, 24, 10)}</span>
                        </div>
                        <div>
                          <strong>Nostr Key:</strong>{" "}
                          <span style={{ fontFamily: "monospace" }}>{truncateString(b.nostr_pubkey_hex, 16, 8)}</span>
                        </div>
                        {b.registration_number && (
                          <div>
                            <strong>Registration / Tax ID:</strong> {b.registration_number}
                          </div>
                        )}
                        {b.merchant_endpoints && b.merchant_endpoints.length > 0 && (
                          <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", marginTop: "0.2rem" }}>
                            <strong>Endpoints:</strong>
                            {b.merchant_endpoints.map((ep, idx) => (
                              <span
                                key={idx}
                                style={{
                                  background: "#ecfeff",
                                  color: "#0e7490",
                                  padding: "0.1rem 0.4rem",
                                  borderRadius: "4px",
                                  fontSize: "0.7rem",
                                  fontFamily: "monospace",
                                }}
                              >
                                {ep}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Anchor Shield Warning Modal */}
      {anchorWarningOpen !== null && (
        <div
          className="modal-overlay"
          style={{
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(4px)",
          }}
          onClick={() => setAnchorWarningOpen(null)}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#0f172a",
              border: "1px solid rgba(245,158,11,0.4)",
              borderRadius: "12px",
              maxWidth: "28rem",
              width: "100%",
              padding: "1.5rem",
              boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5)",
            }}
          >
            <h3
              style={{
                marginTop: 0,
                color: "#f59e0b",
                fontSize: "1.05rem",
                lineHeight: "1.4",
              }}
            >
              {anchorWarningOpen === "hex"
                ? "⚠️ Sensitive Action: Copying Anchor Nostr Key (Level 0)"
                : "⚠️ Sensitive Action: Copying Anchor Root (Level 0)"}
            </h3>

            <div style={{ margin: "1rem 0", fontSize: "0.9rem", lineHeight: "1.6" }}>
              <p style={{ color: "#e2e8f0", margin: "0 0 0.75rem" }}>
                {anchorWarningOpen === "hex"
                  ? "This Nostr public key is derived from your permanent private anchor. Sharing it publicly links all your future social activity to your device root."
                  : "This identifier is your permanent private anchor. Sharing it publicly permanently links all your future trust circles to your device root."}
              </p>
              <p style={{ color: "#94a3b8", margin: 0 }}>
                {anchorWarningOpen === "hex"
                  ? "For public social feeds and general interactions, use your Level 1 Public Persona key."
                  : "For public websites, social logins (iyou_wun), and general interactions, use your Level 1 Public Persona."}
              </p>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
                marginTop: "1.25rem",
              }}
            >
              <button
                type="button"
                onClick={handleAnchorCopyLevel1}
                disabled={!level1Profile}
                style={{
                  padding: "0.625rem 1rem",
                  background: level1Profile ? "#059669" : "#374151",
                  color: "white",
                  fontWeight: 500,
                  border: "none",
                  borderRadius: "8px",
                  width: "100%",
                  cursor: level1Profile ? "pointer" : "not-allowed",
                  transition: "background 0.15s",
                }}
              >
                {anchorWarningOpen === "hex"
                  ? anchorCopiedLabel === "level1-hex"
                    ? "✓ Level 1 Nostr Key Copied"
                    : "Copy Level 1 Public Nostr Key (Recommended)"
                  : anchorCopiedLabel === "level1-did"
                    ? "✓ Level 1 DID Copied"
                    : "Copy Level 1 Public DID (Recommended)"}
              </button>

              <button
                type="button"
                onClick={handleAnchorCopyLevel0}
                disabled={!level0Profile}
                style={{
                  padding: "0.5rem 1rem",
                  background: "transparent",
                  border: "1px solid rgba(239,68,68,0.4)",
                  color: "#f87171",
                  borderRadius: "8px",
                  width: "100%",
                  fontSize: "0.8rem",
                  cursor: level0Profile ? "pointer" : "not-allowed",
                  transition: "background 0.15s",
                }}
              >
                {anchorWarningOpen === "hex"
                  ? anchorCopiedLabel === "level0-hex"
                    ? "✓ Level 0 Anchor Key Copied"
                    : "I Understand, Copy Level 0 Anchor Key"
                  : anchorCopiedLabel === "level0-did"
                    ? "✓ Level 0 Anchor Copied"
                    : "I Understand, Copy Level 0 Anchor"}
              </button>

              <button
                type="button"
                onClick={() => setAnchorWarningOpen(null)}
                style={{
                  padding: "0.5rem 1rem",
                  background: "transparent",
                  border: "none",
                  color: "#64748b",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* Break-Glass Emergency Rotation Modal */}
      {breakGlassModalOpen && (
        <div
          className="modal-overlay"
          style={{
            background: "rgba(0,0,0,0.8)",
            backdropFilter: "blur(6px)",
          }}
          onClick={() => {
            if (!rotationInProgress) {
              setBreakGlassModalOpen(false);
              setRotationConfirmText("");
            }
          }}
        >
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#0f172a",
              border: "1px solid rgba(239,68,68,0.5)",
              borderRadius: "12px",
              maxWidth: "30rem",
              width: "100%",
              padding: "1.5rem",
              boxShadow: "0 25px 50px -12px rgba(0,0,0,0.6)",
            }}
          >
            <h3
              style={{
                marginTop: 0,
                color: "#ef4444",
                fontSize: "1.05rem",
                lineHeight: "1.4",
              }}
            >
              🚨 EMERGENCY BREAK-GLASS: ROTATE PUBLIC IDENTITY
            </h3>

            <div style={{ margin: "1rem 0", fontSize: "0.9rem", lineHeight: "1.6" }}>
              <p style={{ color: "#e2e8f0", margin: "0 0 0.75rem" }}>
                This action burns your current Public DID and Nostr pubkey and
                provisions a fresh Level 1 identity.
              </p>
              <p style={{ color: "#fca5a5", margin: "0 0 0.75rem" }}>
                All active OIDC sessions (iyou_wun, iyou_poly, etc.) and public
                feeds tied to this key will be permanently severed.
              </p>
              <p style={{ color: "#94a3b8", margin: 0 }}>
                Your Level 0 Anchor Sanctum and Inner Circle peer contacts
                remain intact and uncompromised.
              </p>
            </div>

            <div style={{ marginTop: "1.25rem" }}>
              <label
                style={{
                  display: "block",
                  color: "#94a3b8",
                  fontSize: "0.8rem",
                  marginBottom: "0.4rem",
                }}
              >
                Type <strong style={{ color: "#fca5a5" }}>ROTATE PUBLIC IDENTITY</strong> to
                confirm:
              </label>
              <input
                type="text"
                value={rotationConfirmText}
                onChange={(e) => setRotationConfirmText(e.target.value)}
                disabled={rotationInProgress}
                placeholder="ROTATE PUBLIC IDENTITY"
                style={{
                  width: "100%",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "6px",
                  border: "1px solid rgba(239,68,68,0.3)",
                  background: "#1e293b",
                  color: "#e2e8f0",
                  fontSize: "0.9rem",
                  fontFamily: "monospace",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.6rem",
                marginTop: "1.25rem",
              }}
            >
              <button
                type="button"
                disabled={rotationConfirmText !== "ROTATE PUBLIC IDENTITY" || rotationInProgress}
                onClick={async () => {
                  setRotationInProgress(true);
                  try {
                    await invoke("rotate_primary_persona");
                    setBreakGlassModalOpen(false);
                    setRotationConfirmText("");
                    await onRefresh();
                  } catch (err: any) {
                    console.error("Break-glass rotation failed:", err);
                  } finally {
                    setRotationInProgress(false);
                  }
                }}
                style={{
                  padding: "0.625rem 1rem",
                  background:
                    rotationConfirmText === "ROTATE PUBLIC IDENTITY" && !rotationInProgress
                      ? "#dc2626"
                      : "#374151",
                  color: "white",
                  fontWeight: 500,
                  border: "none",
                  borderRadius: "8px",
                  width: "100%",
                  cursor:
                    rotationConfirmText === "ROTATE PUBLIC IDENTITY" && !rotationInProgress
                      ? "pointer"
                      : "not-allowed",
                  transition: "background 0.15s",
                }}
              >
                {rotationInProgress ? "Rotating..." : "Confirm Emergency Rotation"}
              </button>

              <button
                type="button"
                disabled={rotationInProgress}
                onClick={() => {
                  setBreakGlassModalOpen(false);
                  setRotationConfirmText("");
                }}
                style={{
                  padding: "0.5rem 1rem",
                  background: "transparent",
                  border: "none",
                  color: "#64748b",
                  fontSize: "0.8rem",
                  cursor: rotationInProgress ? "not-allowed" : "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
