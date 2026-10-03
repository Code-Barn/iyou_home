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

// EmailOwnershipCredentials (iyou_idp) stored against the signing persona.
// Two categories so trust-tier defaulting is observable in assertions.
const mockEmailCredentials = [
  {
    vc_id: "vc-email-personal",
    issuer_did: "did:web:iyou.me",
    subject_did: "did:key:z6MkPrimary11111111111111111111111111",
    credential_type: "EmailOwnershipCredential",
    fidelity_score: null,
    expiration_date: null,
    raw_payload: JSON.stringify({
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: "urn:uuid:email-personal",
      type: ["VerifiableCredential", "EmailOwnershipCredential"],
      issuer: "did:web:iyou.me",
      credentialSubject: {
        id: "did:key:z6MkPrimary11111111111111111111111111",
        email: "alice@personal.example",
        email_type: "personal",
        verified_at: "2026-10-02T20:30:00Z",
      },
      proof: { type: "RsaSignature2018" },
    }),
  },
  {
    vc_id: "vc-email-work",
    issuer_did: "did:web:iyou.me",
    subject_did: "did:key:z6MkPrimary11111111111111111111111111",
    credential_type: "EmailOwnershipCredential",
    fidelity_score: null,
    expiration_date: null,
    raw_payload: JSON.stringify({
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      id: "urn:uuid:email-work",
      type: ["VerifiableCredential", "EmailOwnershipCredential"],
      issuer: "did:web:iyou.me",
      credentialSubject: {
        id: "did:key:z6MkPrimary11111111111111111111111111",
        email: "alice@work.example",
        email_type: "work",
        verified_at: "2026-10-02T20:31:00Z",
      },
      proof: { type: "RsaSignature2018" },
    }),
  },
];

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_active_profile":
        return Promise.resolve(mockProfiles[1]);
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
      case "get_credentials":
        return Promise.resolve(mockEmailCredentials);
      case "list_roles":
        return Promise.resolve([]);
      case "list_businesses":
        return Promise.resolve([]);
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
      // Level 0: Anchor Sanctum is collapsed by default for zero visual shoulder-surfing exposure
      expect(
        screen.getByText("Level 0 — Anchor Sanctum (Air-Gapped Root)"),
      ).toBeInTheDocument();
      expect(screen.getByText("System Reserved • Zero Exposure")).toBeInTheDocument();
      expect(screen.getByText("Shielded Root — Tap to Expand")).toBeInTheDocument();

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

      // Level 3 & Level 4 sections
      expect(
        screen.getByText(/Level 3 — Accredited Roles & Collectives/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Level 4 — Business & Commerce Profiles/i),
      ).toBeInTheDocument();
    });

    // Expand Level 0 by clicking header
    await act(async () => {
      fireEvent.click(screen.getByText("Level 0 — Anchor Sanctum (Air-Gapped Root)"));
    });

    await waitFor(() => {
      expect(screen.getByText(/Air-Gap Guarantee/i)).toBeInTheDocument();
      expect(screen.getByText("🔒 Locked Anchor")).toBeInTheDocument();
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

  // ---------- Selective disclosure: email claims mapped to contact trust ----------

  /** Open ProjectZero, switch to Contact Enclave, and open the Disclosure modal. */
  async function openDisclosureModal() {
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
    expect(
      screen.getByRole("heading", { name: "Selective Disclosure Cards" }),
    ).toBeInTheDocument();
    // Both email credentials must be loaded before defaults are asserted.
    await waitFor(() => {
      expect(screen.getAllByTestId("email-credential-option")).toHaveLength(2);
    });
  }

  /** Point the target-peer field at a known contact so its trust tier applies. */
  async function targetContact(peerId: string) {
    const input = screen.getByPlaceholderText(/did:key:z6MkTargetPeer/i);
    await act(async () => {
      fireEvent.change(input, { target: { value: peerId } });
    });
  }

  function emailOptionFor(email: string): HTMLElement {
    return screen
      .getAllByTestId("email-credential-option")
      .find((el) => el.textContent?.includes(email))!;
  }

  it("auto-selects personal email only for a Level0 Inner Circle contact", async () => {
    await openDisclosureModal();
    await targetContact("did:key:z6MkPeerAlice000000000000000000000000");

    await waitFor(() => {
      expect(
        emailOptionFor("alice@personal.example").querySelector("input"),
      ).toBeChecked();
    });
    expect(
      emailOptionFor("alice@work.example").querySelector("input"),
    ).not.toBeChecked();
  });

  it("auto-selects work email only for a Level0_5 Trusted Alliance contact", async () => {
    await openDisclosureModal();
    await targetContact("did:key:z6MkPeerBob111111111111111111111111");

    await waitFor(() => {
      expect(
        emailOptionFor("alice@work.example").querySelector("input"),
      ).toBeChecked();
    });
    expect(
      emailOptionFor("alice@personal.example").querySelector("input"),
    ).not.toBeChecked();
  });

  it("selects no email credentials for a Level1 Peer contact", async () => {
    await openDisclosureModal();
    await targetContact("did:key:z6MkPeerCharlie22222222222222222222");

    await waitFor(() => {
      expect(
        emailOptionFor("alice@personal.example").querySelector("input"),
      ).not.toBeChecked();
    });
    expect(
      emailOptionFor("alice@work.example").querySelector("input"),
    ).not.toBeChecked();
  });

  it("attaches only the selected email claims to the signed disclosure card", async () => {
    await openDisclosureModal();
    await targetContact("did:key:z6MkPeerAlice000000000000000000000000");
    await waitFor(() => {
      expect(
        emailOptionFor("alice@personal.example").querySelector("input"),
      ).toBeChecked();
    });

    mockInvoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Signed Card" }));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "generate_disclosure_card",
        expect.objectContaining({
          disclosedEmailCredentials: [
            expect.objectContaining({
              vc_id: "vc-email-personal",
              email: "alice@personal.example",
              email_type: "personal",
            }),
          ],
        }),
      );
    });
  });

  it("honors manual toggling off a trust-tier default before signing", async () => {
    await openDisclosureModal();
    await targetContact("did:key:z6MkPeerAlice000000000000000000000000");
    await waitFor(() => {
      expect(
        emailOptionFor("alice@personal.example").querySelector("input"),
      ).toBeChecked();
    });

    // Deselect the defaulted personal claim; nothing should be disclosed.
    await act(async () => {
      fireEvent.click(
        emailOptionFor("alice@personal.example").querySelector("input")!,
      );
    });

    mockInvoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Signed Card" }));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "generate_disclosure_card",
        expect.objectContaining({ disclosedEmailCredentials: [] }),
      );
    });
  });

  it("allows manually adding a work email claim for a Level1 peer", async () => {
    await openDisclosureModal();
    await targetContact("did:key:z6MkPeerCharlie22222222222222222222");
    await waitFor(() => {
      expect(
        emailOptionFor("alice@work.example").querySelector("input"),
      ).not.toBeChecked();
    });

    // Opt-in override: a peer may still receive a work claim if the user ticks it.
    await act(async () => {
      fireEvent.click(
        emailOptionFor("alice@work.example").querySelector("input")!,
      );
    });

    mockInvoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Signed Card" }));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "generate_disclosure_card",
        expect.objectContaining({
          disclosedEmailCredentials: [
            expect.objectContaining({ email_type: "work" }),
          ],
        }),
      );
    });
  });

  it("discloses no email when no target contact is selected", async () => {
    await openDisclosureModal();

    mockInvoke.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate Signed Card" }));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "generate_disclosure_card",
        expect.objectContaining({ disclosedEmailCredentials: [] }),
      );
    });
  });

  it("still applies tier defaults when the contact is chosen before credentials resolve", async () => {
    // Regression guard: the credential fetch is async. If the user selects the
    // contact while `get_credentials` is still in flight, the tier default must
    // still be applied once the credentials land. Keying the defaulting effect
    // on the contact alone used to latch the empty selection here.
    let resolveCreds!: (v: unknown[]) => void;
    const deferredCreds = new Promise<unknown[]>((res) => {
      resolveCreds = res;
    });
    const baseImpl = mockInvoke.getMockImplementation()!;
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_credentials") return deferredCreds;
      return baseImpl(cmd, args);
    });

    try {
      await act(async () => {
        render(<ProjectZero />);
      });
      const contactTabBtn = await screen.findByRole("button", {
        name: /Contact Enclave/i,
      });
      await act(async () => {
        fireEvent.click(contactTabBtn);
      });
      await act(async () => {
        fireEvent.click(
          await screen.findByRole("button", { name: /Selective Disclosure Cards/i }),
        );
      });

      // Select the Level0 contact while credentials are still unresolved.
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText(/did:key:z6MkTargetPeer/i), {
          target: { value: "did:key:z6MkPeerAlice000000000000000000000000" },
        });
      });

      // Now let the credentials arrive.
      await act(async () => {
        resolveCreds(mockEmailCredentials);
        await deferredCreds;
      });

      await waitFor(() => {
        expect(
          emailOptionFor("alice@personal.example").querySelector("input"),
        ).toBeChecked();
      });
      expect(
        emailOptionFor("alice@work.example").querySelector("input"),
      ).not.toBeChecked();
    } finally {
      mockInvoke.mockImplementation(baseImpl);
    }
  });
});
