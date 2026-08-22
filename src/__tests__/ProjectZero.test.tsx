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

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import ProjectZero from "../components/enclave/ProjectZero";
import { Profile, PeerContact } from "../lib/types";

const mockProfiles: Profile[] = [
  {
    profile_id: "anchor",
    profile_name: "Anchor Identity",
    derivation_index: 0,
    did: "did:key:z6MkAnchor00000000000000000000000000",
    level: 0,
    is_system_reserved: true,
    nostr_pubkey_hex: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  {
    profile_id: "primary",
    profile_name: "Public Persona",
    derivation_index: 1,
    did: "did:key:z6MkPrimary11111111111111111111111111",
    level: 1,
    is_system_reserved: false,
    nostr_pubkey_hex: "1111111111111111111111111111111111111111111111111111111111111111",
  },
  {
    profile_id: "burner_alpha",
    profile_name: "Burner Alpha",
    derivation_index: 2,
    did: "did:key:z6MkBurner22222222222222222222222222",
    level: 2,
    is_system_reserved: false,
    nostr_pubkey_hex: "2222222222222222222222222222222222222222222222222222222222222222",
  },
];

const mockContacts: PeerContact[] = [
  {
    peer_id: "did:key:z6MkPeerAlice000000000000000000000000",
    display_name: "Alice Sanctum",
    trust_level: "level0",
    disclosed_aliases: ["alice_burner_hex", "did:key:z6MkAliceSock"],
    attestation_receipt: JSON.stringify({ type: ["VerifiableCredential"] }),
    created_at: 1000,
    updated_at: 1000,
  },
  {
    peer_id: "did:key:z6MkPeerBob111111111111111111111111",
    display_name: "Bob Alliance",
    trust_level: "level0_5",
    disclosed_aliases: ["bob_nostr_key"],
    created_at: 1000,
    updated_at: 1000,
  },
  {
    peer_id: "did:key:z6MkPeerCharlie22222222222222222222",
    display_name: "Charlie Peer",
    trust_level: "level1",
    disclosed_aliases: [],
    created_at: 1000,
    updated_at: 1000,
  },
];

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "list_profiles":
        return Promise.resolve(mockProfiles);
      case "list_contacts":
        return Promise.resolve(mockContacts);
      case "get_active_did":
        return Promise.resolve("did:key:z6MkPrimary11111111111111111111111111");
      case "set_active_profile":
        return Promise.resolve();
      case "add_profile":
        return Promise.resolve({
          profile_id: "new_persona",
          profile_name: args?.profileName || "New Persona",
          derivation_index: 3,
          did: "did:key:z6MkNew33333333333333333333333333",
          level: 2,
          is_system_reserved: false,
        });
      case "remove_profile":
        return Promise.resolve();
      case "upsert_contact":
        return Promise.resolve(args?.contact);
      case "delete_contact":
        return Promise.resolve();
      case "generate_disclosure_card":
        return Promise.resolve(
          JSON.stringify({
            "@context": ["https://www.w3.org/2018/credentials/v1"],
            id: "urn:uuid:test-card",
            type: ["VerifiableCredential", "SelectiveDisclosureCard"],
            issuer: "did:key:z6MkPrimary11111111111111111111111111",
            credentialSubject: {
              id: "did:key:z6MkPrimary11111111111111111111111111",
              name: "Public Persona",
              disclosed_aliases: [],
            },
            proof: {
              type: "Ed25519Signature2018",
              proofValue: "deadbeef",
            },
          }),
        );
      case "import_disclosure_card":
        return Promise.resolve({
          peer_id: "did:key:z6MkImportedPeer",
          display_name: "Imported Peer",
          trust_level: "level1",
          disclosed_aliases: ["alias1"],
          created_at: 1000,
          updated_at: 1000,
        });
      default:
        return Promise.resolve();
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
  readText: vi.fn().mockResolvedValue(""),
}));

describe("ProjectZero Suite", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("renders Project Zero banner and hierarchy overview", async () => {
    await act(async () => {
      render(<ProjectZero />);
    });

    expect(screen.getByText("Project Zero")).toBeInTheDocument();
    expect(screen.getByText("🛡️ Air-Gapped Zero Enclave Active")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Anchor (L0)")).toBeInTheDocument();
      expect(screen.getByText("Primary (L1)")).toBeInTheDocument();
      expect(screen.getByText("Burners (L2+)")).toBeInTheDocument();
    });
  });

  it("renders the 3 distinct persona tiers in Persona Matrix", async () => {
    await act(async () => {
      render(<ProjectZero />);
    });

    await waitFor(() => {
      // Level 0: Anchor Sanctum
      expect(
        screen.getByText("Level 0 — Anchor Sanctum (Air-Gapped Root)"),
      ).toBeInTheDocument();
      expect(screen.getByText("System Reserved • Zero Exposure")).toBeInTheDocument();
      expect(screen.getByText(/Air-Gap Guarantee/i)).toBeInTheDocument();
      expect(screen.getByText("🔒 Locked Anchor")).toBeInTheDocument();

      // Level 1: Public Persona
      expect(
        screen.getByText("Level 1 — Primary Identity (Public Persona)"),
      ).toBeInTheDocument();
      expect(screen.getByText("Public Persona")).toBeInTheDocument();
      expect(screen.getByText("Active Persona")).toBeInTheDocument();

      // Level 2: Burner Personas
      expect(
        screen.getByText(/Level 2\+ — Contextual \/ Burner Identities/i),
      ).toBeInTheDocument();
      expect(screen.getByText("Burner Alpha")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /\+ Create Persona/i })).toBeInTheDocument();
    });
  });

  it("switches to Contact Enclave tab and displays peer trust badges", async () => {
    await act(async () => {
      render(<ProjectZero />);
    });

    const contactTabBtn = await screen.findByRole("button", {
      name: /Contact Enclave/i,
    });

    await act(async () => {
      fireEvent.click(contactTabBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Alice Sanctum")).toBeInTheDocument();
      expect(screen.getByText("Inner Circle")).toBeInTheDocument();
      expect(screen.getByText("Bob Alliance")).toBeInTheDocument();
      expect(screen.getByText("Trusted Alliance")).toBeInTheDocument();
      expect(screen.getByText("Charlie Peer")).toBeInTheDocument();
      expect(screen.getByText("Peer")).toBeInTheDocument();
    });
  });

  it("opens Selective Disclosure modal and generates disclosure card", async () => {
    await act(async () => {
      render(<ProjectZero />);
    });

    const contactTabBtn = await screen.findByRole("button", {
      name: /Contact Enclave/i,
    });
    await act(async () => {
      fireEvent.click(contactTabBtn);
    });

    const disclosureBtn = await screen.findByRole("button", {
      name: /Selective Disclosure Cards/i,
    });
    await act(async () => {
      fireEvent.click(disclosureBtn);
    });

    expect(screen.getByRole("heading", { name: "Selective Disclosure Cards" })).toBeInTheDocument();

    const generateBtn = screen.getByRole("button", {
      name: "Generate Signed Card",
    });

    await act(async () => {
      fireEvent.click(generateBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "generate_disclosure_card",
        expect.objectContaining({
          displayName: "Public Persona",
          tier: "Tier 0 Inner Circle",
        }),
      );
      expect(
        screen.getByText("✓ Signed Attestation Card Payload Ready"),
      ).toBeInTheDocument();
    });
  });

  it("handles importing a peer disclosure card in the modal", async () => {
    await act(async () => {
      render(<ProjectZero />);
    });

    const contactTabBtn = await screen.findByRole("button", {
      name: /Contact Enclave/i,
    });
    await act(async () => {
      fireEvent.click(contactTabBtn);
    });

    const disclosureBtn = await screen.findByRole("button", {
      name: /Selective Disclosure Cards/i,
    });
    await act(async () => {
      fireEvent.click(disclosureBtn);
    });

    const importTabBtn = screen.getByRole("button", {
      name: "Import Peer Card",
    });
    await act(async () => {
      fireEvent.click(importTabBtn);
    });

    const textarea = screen.getByPlaceholderText(/Paste \{"@context":/i);
    await act(async () => {
      fireEvent.change(textarea, {
        target: { value: '{"@context": ["test"], "proof": {}}' },
      });
    });

    const submitImportBtn = screen.getByRole("button", {
      name: "Validate & Import Card",
    });
    await act(async () => {
      fireEvent.click(submitImportBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "import_disclosure_card",
        expect.objectContaining({
          cardJson: '{"@context": ["test"], "proof": {}}',
        }),
      );
      expect(
        screen.getByText("✓ Cryptographic Verification Succeeded!"),
      ).toBeInTheDocument();
    });
  });
});
