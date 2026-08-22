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
import { Profile, PeerContact } from "../../lib/types";
import PersonaMatrix from "./PersonaMatrix";
import ContactList from "./ContactList";
import DisclosureModal from "./DisclosureModal";

export default function ProjectZero() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [contacts, setContacts] = useState<PeerContact[]>([]);
  const [activeDid, setActiveDid] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<"matrix" | "contacts">("matrix");
  const [showDisclosureModal, setShowDisclosureModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setError(null);
    try {
      const [profilesList, contactsList, did] = await Promise.all([
        invoke<Profile[]>("list_profiles"),
        invoke<PeerContact[]>("list_contacts"),
        invoke<string | null>("get_active_did"),
      ]);
      setProfiles(profilesList || []);
      setContacts(contactsList || []);
      setActiveDid(did);
    } catch (err: any) {
      console.error("Failed to load Project Zero Enclave data:", err);
      setError(err.toString());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const anchorCount = profiles.filter(
    (p) => p.level === 0 || p.derivation_index === 0 || p.is_system_reserved,
  ).length;
  const personaCount = profiles.filter(
    (p) => (p.level === 1 || p.derivation_index === 1) && !p.is_system_reserved,
  ).length;
  const burnerCount = profiles.filter(
    (p) =>
      p.level >= 2 ||
      (p.derivation_index >= 2 && !p.is_system_reserved && p.level !== 0),
  ).length;

  return (
    <div className="component-container">
      {/* Top Banner with Project Zero Branding */}
      <div
        style={{
          background: "linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%)",
          color: "white",
          padding: "1.5rem",
          borderRadius: "12px",
          marginBottom: "1.5rem",
          boxShadow: "0 4px 12px rgba(49, 46, 129, 0.25)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            flexWrap: "wrap",
            gap: "1rem",
          }}
        >
          <div>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                background: "rgba(255, 255, 255, 0.15)",
                backdropFilter: "blur(4px)",
                padding: "0.25rem 0.75rem",
                borderRadius: "20px",
                fontSize: "0.8rem",
                fontWeight: 600,
                marginBottom: "0.5rem",
                border: "1px solid rgba(255, 255, 255, 0.2)",
              }}
            >
              🛡️ Air-Gapped Zero Enclave Active
            </div>
            <h2
              style={{
                margin: "0 0 0.25rem",
                color: "white",
                borderBottom: "none",
                padding: 0,
                fontSize: "1.6rem",
              }}
            >
              Project Zero
            </h2>
            <p
              style={{
                margin: 0,
                color: "rgba(255, 255, 255, 0.8)",
                fontSize: "0.9rem",
              }}
            >
              Multi-Tier Persona Matrix & Cryptographic Peer Trust Enclave
            </p>
          </div>

          <div
            style={{
              display: "flex",
              gap: "1rem",
              background: "rgba(0, 0, 0, 0.2)",
              padding: "0.75rem 1rem",
              borderRadius: "8px",
              fontSize: "0.85rem",
            }}
          >
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                {anchorCount}
              </div>
              <div style={{ fontSize: "0.7rem", color: "#c7d2fe" }}>
                Anchor (L0)
              </div>
            </div>
            <div
              style={{
                width: "1px",
                background: "rgba(255,255,255,0.2)",
                margin: "0 0.2rem",
              }}
            />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                {personaCount}
              </div>
              <div style={{ fontSize: "0.7rem", color: "#c7d2fe" }}>
                Primary (L1)
              </div>
            </div>
            <div
              style={{
                width: "1px",
                background: "rgba(255,255,255,0.2)",
                margin: "0 0.2rem",
              }}
            />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                {burnerCount}
              </div>
              <div style={{ fontSize: "0.7rem", color: "#c7d2fe" }}>
                Burners (L2+)
              </div>
            </div>
            <div
              style={{
                width: "1px",
                background: "rgba(255,255,255,0.2)",
                margin: "0 0.2rem",
              }}
            />
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                {contacts.length}
              </div>
              <div style={{ fontSize: "0.7rem", color: "#c7d2fe" }}>
                Contacts
              </div>
            </div>
          </div>
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      {/* Sub-Navigation Tabs */}
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          marginBottom: "1.5rem",
          borderBottom: "2px solid #e5e7eb",
          paddingBottom: "0.5rem",
        }}
      >
        <button
          type="button"
          onClick={() => setSubTab("matrix")}
          style={{
            padding: "0.6rem 1.2rem",
            background: subTab === "matrix" ? "#312e81" : "transparent",
            color: subTab === "matrix" ? "white" : "#4b5563",
            border: "none",
            borderRadius: "6px",
            fontWeight: 600,
            fontSize: "0.9rem",
            boxShadow: subTab === "matrix" ? "0 2px 4px rgba(0,0,0,0.1)" : "none",
          }}
        >
          🎭 Persona Matrix ({profiles.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTab("contacts")}
          style={{
            padding: "0.6rem 1.2rem",
            background: subTab === "contacts" ? "#312e81" : "transparent",
            color: subTab === "contacts" ? "white" : "#4b5563",
            border: "none",
            borderRadius: "6px",
            fontWeight: 600,
            fontSize: "0.9rem",
            boxShadow:
              subTab === "contacts" ? "0 2px 4px rgba(0,0,0,0.1)" : "none",
          }}
        >
          👥 Contact Enclave ({contacts.length})
        </button>
      </div>

      {/* Content Rendering */}
      {loading ? (
        <div className="section" style={{ textAlign: "center", padding: "2rem" }}>
          <p className="muted">Loading Project Zero Enclave data...</p>
        </div>
      ) : (
        <>
          {subTab === "matrix" && (
            <PersonaMatrix
              profiles={profiles}
              activeDid={activeDid}
              onRefresh={fetchData}
            />
          )}

          {subTab === "contacts" && (
            <ContactList
              contacts={contacts}
              onRefresh={fetchData}
              onOpenDisclosure={() => setShowDisclosureModal(true)}
            />
          )}
        </>
      )}

      {/* Selective Disclosure Modal */}
      <DisclosureModal
        isOpen={showDisclosureModal}
        onClose={() => setShowDisclosureModal(false)}
        profiles={profiles}
        contacts={contacts}
        onRefresh={fetchData}
      />
    </div>
  );
}
