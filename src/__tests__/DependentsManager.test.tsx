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

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import DependentsManager, {
  getAgeBracketLabel,
  getCustodyStageLabel,
  shortDid,
} from "../components/DependentsManager";
import type { DependentProfile, DependentProvisioningBundle } from "../lib/types";

type InvokeArgs = Record<string, unknown>;

const { mockInvoke, mockWriteText, state } = vi.hoisted(() => {
  const state = {
    dependents: [] as DependentProfile[],
    bundle: null as DependentProvisioningBundle | null,
    qrUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    calls: [] as { cmd: string; args?: InvokeArgs }[],
  };

  const mockInvoke = vi.fn((cmd: string, args?: InvokeArgs) => {
    state.calls.push({ cmd, args });
    switch (cmd) {
      case "list_dependents":
        return Promise.resolve(state.dependents);
      case "get_dependent_provisioning_bundle":
        return Promise.resolve(
          state.bundle || {
            bundle_version: "1.0",
            dependent_id: (args?.dependentId as string) || "dep_violette_1",
            petname: "Violette",
            did: "did:key:z6MkuVioletteLeaf1234567890",
            ed25519_private_key_b58: "MockEd25519PrivKeyBase58==",
            nostr_private_key_hex: "0123456789abcdef".repeat(4),
            nostr_pubkey_hex: "fedcba9876543210".repeat(4),
            guardian_did: "did:key:z6MkuParentGuardian1234567890",
            custody_stage: 1,
            allowed_relays: ["wss://relay.iyou.me"],
            attestation_vc: { type: "AgeBracketCredential" },
            exported_at: 1700000000,
          }
        );
      case "render_qr_code":
        return Promise.resolve(state.qrUrl);
      case "create_dependent_profile": {
        const newDep: DependentProfile = {
          dependent_id: `dep_${(args?.name as string).toLowerCase()}_123`,
          name: args?.name as string,
          birth_year: args?.birthYear as number,
          custody_stage: args?.custodyStage as number,
          dependent_index: state.dependents.length,
          did: `did:key:z6Mku${args?.name}123`,
          nostr_pubkey_hex: "aa".repeat(32),
          guardian_did: "did:key:z6MkuParentGuardian",
          allowed_relays: ["wss://relay.iyou.me"],
          revoked: false,
          created_at: Math.floor(Date.now() / 1000),
          graduated_at: null,
        };
        state.dependents.push(newDep);
        return Promise.resolve(newDep);
      }
      case "graduate_dependent_to_sovereign": {
        const depId = (args?.dependentId as string) || "";
        const dep = state.dependents.find((d) => d.dependent_id === depId);
        if (dep) {
          dep.custody_stage = 3;
          dep.graduated_at = Math.floor(Date.now() / 1000);
        }
        return Promise.resolve(
          state.bundle || {
            bundle_version: "1.0",
            dependent_id: depId,
            petname: dep?.name || "AdultChild",
            did: dep?.did || "did:key:z6MkuAdultLeaf1234567890",
            ed25519_private_key_b58: "MockEd25519PrivKeyBase58==",
            nostr_private_key_hex: "0123456789abcdef".repeat(4),
            nostr_pubkey_hex: "fedcba9876543210".repeat(4),
            guardian_did: "did:key:z6MkuParentGuardian1234567890",
            custody_stage: 3,
            allowed_relays: ["wss://relay.iyou.me"],
            attestation_vc: { type: "AgeBracketCredential" },
            exported_at: 1700000000,
          }
        );
      }
      default:
        return Promise.resolve();
    }
  });

  const mockWriteText = vi.fn().mockResolvedValue(undefined);

  return { mockInvoke, mockWriteText, state };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mockWriteText,
}));

describe("DependentsManager", () => {
  const currentYear = new Date().getFullYear();

  beforeEach(() => {
    state.dependents = [];
    state.bundle = null;
    state.calls = [];
    mockInvoke.mockClear();
    mockWriteText.mockClear();
  });

  describe("Helper unit functions", () => {
    it("correctly identifies age brackets and labels", () => {
      expect(getAgeBracketLabel(currentYear - 5, 1)).toBe("Child (<13)");
      expect(getAgeBracketLabel(currentYear - 15, 2)).toBe("Teen (13–17)");
      expect(getAgeBracketLabel(currentYear - 20, 3)).toBe("Adult (18+)");
      expect(getCustodyStageLabel(1)).toBe("Guided Delegation");
      expect(getCustodyStageLabel(2)).toBe("Autonomous");
      expect(getCustodyStageLabel(3)).toBe("Sovereign Eligible");
      expect(shortDid("did:key:z6MkuVioletteLeaf1234567890")).toBe("did:key:z6Mk…34567890");
    });
  });

  it("renders empty state when no dependents exist", async () => {
    render(<DependentsManager />);

    expect(await screen.findByTestId("dependents-empty")).toBeInTheDocument();
    expect(screen.getByText(/No saved dependent accounts found/i)).toBeInTheDocument();
    expect(screen.getByText(/\+ Add Dependent/i)).toBeInTheDocument();
  });

  it("lists saved dependents with names, correct age brackets, and custody stages", async () => {
    state.dependents = [
      {
        dependent_id: "dep_violette_1",
        name: "Violette",
        birth_year: currentYear - 8,
        custody_stage: 1,
        dependent_index: 0,
        did: "did:key:z6MkuVioletteLeaf1234567890",
        nostr_pubkey_hex: "aa".repeat(32),
        guardian_did: "did:key:z6MkuParentGuardian",
        allowed_relays: ["wss://relay.iyou.me"],
        revoked: false,
        created_at: 1700000000,
        graduated_at: null,
      },
      {
        dependent_id: "dep_julian_2",
        name: "Julian",
        birth_year: currentYear - 15,
        custody_stage: 2,
        dependent_index: 1,
        did: "did:key:z6MkuJulianLeaf1234567890",
        nostr_pubkey_hex: "bb".repeat(32),
        guardian_did: "did:key:z6MkuParentGuardian",
        allowed_relays: ["wss://relay.iyou.me"],
        revoked: false,
        created_at: 1700000100,
        graduated_at: null,
      },
    ];

    render(<DependentsManager />);

    expect(await screen.findByTestId("dependent-card-dep_violette_1")).toBeInTheDocument();
    expect(screen.getByTestId("dependent-name-dep_violette_1")).toHaveTextContent("Violette");
    expect(screen.getByTestId("dependent-bracket-dep_violette_1")).toHaveTextContent("Child (<13)");
    expect(screen.getByTestId("dependent-stage-dep_violette_1")).toHaveTextContent("Guided Delegation");

    expect(screen.getByTestId("dependent-card-dep_julian_2")).toBeInTheDocument();
    expect(screen.getByTestId("dependent-name-dep_julian_2")).toHaveTextContent("Julian");
    expect(screen.getByTestId("dependent-bracket-dep_julian_2")).toHaveTextContent("Teen (13–17)");
    expect(screen.getByTestId("dependent-stage-dep_julian_2")).toHaveTextContent("Autonomous");

    expect(screen.getByTestId("provision-dependent-dep_violette_1")).toBeInTheDocument();
    expect(screen.getByTestId("provision-dependent-dep_julian_2")).toBeInTheDocument();
  });

  it("opens provisioning modal and displays leaf QR image and bundle JSON when Provision Device is clicked", async () => {
    state.dependents = [
      {
        dependent_id: "dep_violette_1",
        name: "Violette",
        birth_year: currentYear - 8,
        custody_stage: 1,
        dependent_index: 0,
        did: "did:key:z6MkuVioletteLeaf1234567890",
        nostr_pubkey_hex: "aa".repeat(32),
        guardian_did: "did:key:z6MkuParentGuardian",
        allowed_relays: ["wss://relay.iyou.me"],
        revoked: false,
        created_at: 1700000000,
        graduated_at: null,
      },
    ];

    render(<DependentsManager />);

    const provisionBtn = await screen.findByTestId("provision-dependent-dep_violette_1");
    fireEvent.click(provisionBtn);

    expect(mockInvoke).toHaveBeenCalledWith("get_dependent_provisioning_bundle", {
      dependentId: "dep_violette_1",
    });

    await waitFor(() => {
      expect(screen.getByTestId("provision-modal")).toBeInTheDocument();
    });

    expect(screen.getByText(/Device Provisioning: Violette/i)).toBeInTheDocument();
    expect(screen.getByTestId("provisioning-qr-image")).toHaveAttribute("src", state.qrUrl);
    expect(screen.getByTestId("provisioning-qr-hint")).toBeInTheDocument();

    const textarea = screen.getByTestId("provisioning-bundle-json");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue(
      JSON.stringify(
        {
          bundle_version: "1.0",
          dependent_id: "dep_violette_1",
          petname: "Violette",
          did: "did:key:z6MkuVioletteLeaf1234567890",
          ed25519_private_key_b58: "MockEd25519PrivKeyBase58==",
          nostr_private_key_hex: "0123456789abcdef".repeat(4),
          nostr_pubkey_hex: "fedcba9876543210".repeat(4),
          guardian_did: "did:key:z6MkuParentGuardian1234567890",
          custody_stage: 1,
          allowed_relays: ["wss://relay.iyou.me"],
          attestation_vc: { type: "AgeBracketCredential" },
          exported_at: 1700000000,
        },
        null,
        2
      )
    );
  });

  it("copies provisioning bundle to clipboard when Copy Bundle is clicked", async () => {
    state.dependents = [
      {
        dependent_id: "dep_violette_1",
        name: "Violette",
        birth_year: currentYear - 8,
        custody_stage: 1,
        dependent_index: 0,
        did: "did:key:z6MkuVioletteLeaf1234567890",
        nostr_pubkey_hex: "aa".repeat(32),
        guardian_did: "did:key:z6MkuParentGuardian",
        allowed_relays: ["wss://relay.iyou.me"],
        revoked: false,
        created_at: 1700000000,
        graduated_at: null,
      },
    ];

    render(<DependentsManager />);

    const provisionBtn = await screen.findByTestId("provision-dependent-dep_violette_1");
    fireEvent.click(provisionBtn);

    const copyBtn = await screen.findByTestId("copy-provisioning-bundle");
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalled();
    });

    expect(screen.getByText(/Copied!/i)).toBeInTheDocument();
  });

  it("allows closing the provisioning modal", async () => {
    state.dependents = [
      {
        dependent_id: "dep_violette_1",
        name: "Violette",
        birth_year: currentYear - 8,
        custody_stage: 1,
        dependent_index: 0,
        did: "did:key:z6MkuVioletteLeaf1234567890",
        nostr_pubkey_hex: "aa".repeat(32),
        guardian_did: "did:key:z6MkuParentGuardian",
        allowed_relays: ["wss://relay.iyou.me"],
        revoked: false,
        created_at: 1700000000,
        graduated_at: null,
      },
    ];

    render(<DependentsManager />);

    const provisionBtn = await screen.findByTestId("provision-dependent-dep_violette_1");
    fireEvent.click(provisionBtn);

    const closeBtn = await screen.findByTestId("close-provisioning-modal");
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("provision-modal")).not.toBeInTheDocument();
    });
  });

  it("disables the provision button for revoked dependents", async () => {
    state.dependents = [
      {
        dependent_id: "dep_revoked_1",
        name: "RevokedChild",
        birth_year: currentYear - 10,
        custody_stage: 1,
        dependent_index: 0,
        did: "did:key:z6MkuRevoked1234567890",
        nostr_pubkey_hex: "aa".repeat(32),
        guardian_did: "did:key:z6MkuParentGuardian",
        allowed_relays: ["wss://relay.iyou.me"],
        revoked: true,
        created_at: 1700000000,
        graduated_at: null,
      },
    ];

    render(<DependentsManager />);

    const btn = await screen.findByTestId("provision-dependent-dep_revoked_1");
    expect(btn).toBeDisabled();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });

  it("allows adding a new dependent and reloads the list", async () => {
    render(<DependentsManager />);

    const addBtn = await screen.findByTestId("add-dependent-btn");
    fireEvent.click(addBtn);

    expect(screen.getByTestId("add-dependent-modal")).toBeInTheDocument();

    const nameInput = screen.getByTestId("dependent-name-input");
    const birthYearInput = screen.getByTestId("dependent-birthyear-input");
    const custodySelect = screen.getByTestId("dependent-custody-select");

    fireEvent.change(nameInput, { target: { value: "Leo" } });
    fireEvent.change(birthYearInput, { target: { value: "2018" } });
    fireEvent.change(custodySelect, { target: { value: "1" } });

    const submitBtn = screen.getByTestId("submit-create-dependent");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_dependent_profile", {
        name: "Leo",
        birthYear: 2018,
        custodyStage: 1,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("add-dependent-modal")).not.toBeInTheDocument();
    });

    expect(await screen.findByTestId("dependent-name-dep_leo_123")).toHaveTextContent("Leo");
  });

  describe("Emancipation Guard & Graduation", () => {
    it("strictly renders emancipation button only for dependents >= 18 and hides it for minors", async () => {
      state.dependents = [
        {
          dependent_id: "dep_minor_child",
          name: "YoungChild",
          birth_year: currentYear - 8, // 8yo
          custody_stage: 1,
          dependent_index: 0,
          did: "did:key:z6MkuYoung1",
          nostr_pubkey_hex: "aa".repeat(32),
          guardian_did: "did:key:z6MkuParentGuardian",
          allowed_relays: ["wss://relay.iyou.me"],
          revoked: false,
          created_at: 1700000000,
          graduated_at: null,
        },
        {
          dependent_id: "dep_minor_teen",
          name: "TeenChild",
          birth_year: currentYear - 16, // 16yo
          custody_stage: 2,
          dependent_index: 1,
          did: "did:key:z6MkuTeen2",
          nostr_pubkey_hex: "bb".repeat(32),
          guardian_did: "did:key:z6MkuParentGuardian",
          allowed_relays: ["wss://relay.iyou.me"],
          revoked: false,
          created_at: 1700000100,
          graduated_at: null,
        },
        {
          dependent_id: "dep_adult_18",
          name: "AdultChild",
          birth_year: currentYear - 18, // 18yo
          custody_stage: 2,
          dependent_index: 2,
          did: "did:key:z6MkuAdult3",
          nostr_pubkey_hex: "cc".repeat(32),
          guardian_did: "did:key:z6MkuParentGuardian",
          allowed_relays: ["wss://relay.iyou.me"],
          revoked: false,
          created_at: 1700000200,
          graduated_at: null,
        },
      ];

      render(<DependentsManager />);

      // Minors must NOT have the emancipation button
      expect(await screen.findByTestId("dependent-card-dep_minor_child")).toBeInTheDocument();
      expect(screen.queryByTestId("dependent-emancipate-dep_minor_child")).not.toBeInTheDocument();
      expect(screen.queryByTestId("dependent-emancipate-dep_minor_teen")).not.toBeInTheDocument();

      // 18+ dependent MUST have the emancipation button
      const adultEmancipateBtn = screen.getByTestId("dependent-emancipate-dep_adult_18");
      expect(adultEmancipateBtn).toBeInTheDocument();
      expect(adultEmancipateBtn).toHaveTextContent("Emancipate (18+ / graduate)");
    });

    it("requires two-step confirmation to graduate dependent to sovereign and opens provisioning modal", async () => {
      state.dependents = [
        {
          dependent_id: "dep_adult_19",
          name: "SovereignReady",
          birth_year: currentYear - 19,
          custody_stage: 2,
          dependent_index: 0,
          did: "did:key:z6MkuReady1",
          nostr_pubkey_hex: "dd".repeat(32),
          guardian_did: "did:key:z6MkuParentGuardian",
          allowed_relays: ["wss://relay.iyou.me"],
          revoked: false,
          created_at: 1700000300,
          graduated_at: null,
        },
      ];

      render(<DependentsManager />);

      const emancipateBtn = await screen.findByTestId("dependent-emancipate-dep_adult_19");
      expect(emancipateBtn).toHaveTextContent("Emancipate (18+ / graduate)");

      // Step 1: Click once to arm
      fireEvent.click(emancipateBtn);
      expect(emancipateBtn).toHaveTextContent("⚠️ Confirm Emancipation");
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "graduate_dependent_to_sovereign",
        expect.anything()
      );

      // Step 2: Click again to execute
      fireEvent.click(emancipateBtn);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("graduate_dependent_to_sovereign", {
          dependentId: "dep_adult_19",
        });
      });

      // Shows success message
      expect(
        await screen.findByText(/🎓 SovereignReady has graduated to sovereign status/i)
      ).toBeInTheDocument();

      // Emancipation button is gone and graduated badge is rendered
      expect(screen.queryByTestId("dependent-emancipate-dep_adult_19")).not.toBeInTheDocument();
      expect(screen.getByTestId("dependent-graduated-badge-dep_adult_19")).toHaveTextContent(
        "🎓 Sovereign / Graduated"
      );
    });
  });
});

