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
import { vi } from "vitest";
import GovernanceAuditor from "../components/GovernanceAuditor";
import QuickDispatchModal from "../components/QuickDispatchModal";
import SovereignFootprint from "../components/SovereignFootprint";
import GlobalStatusBar from "../components/GlobalStatusBar";
import type { Profile } from "../lib/types";

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_service_statuses":
        return Promise.resolve({
          SigBridge: "running",
          Blossom: "running",
          Nostr: "running",
          Chat: "stopped",
        });
      case "get_active_profile":
        return Promise.resolve({
          profile_id: "primary",
          profile_name: "Primary Persona",
          did: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
          level: 1,
          derivation_index: 1,
          is_system_reserved: false,
          active: true,
        });
      case "list_profiles":
        return Promise.resolve([
          {
            profile_id: "primary",
            profile_name: "Primary Persona",
            did: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
            level: 1,
            derivation_index: 1,
            is_system_reserved: false,
          },
        ]);
      case "get_active_did":
        return Promise.resolve("did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH");
      case "get_sync_status":
        return Promise.resolve({
          last_synced_at: Math.floor(Date.now() / 1000) - 120,
          local_notes_count: 14,
          local_blobs_count: 5,
        });
      case "get_ecosystem_footprint":
        return Promise.resolve({
          social_notes_count: 28,
          governance_ballots_count: 6,
          evidence_records_count: 15,
          kinship_entries_count: 4,
          media_blobs_count: 9,
          media_storage_bytes: 2097152,
          registered_ledgers_count: 7,
          safe_beacons_count: 3,
          talk_rooms_count: 5,
          clar_entries_count: 12,
          draw_manifests_count: 2,
          ride_ledger_count: 1,
          stay_manifests_count: 4,
          farm_ledger_count: 8,
          blog_posts_count: 11,
        });
      case "calculate_vote_merkle_root":
        return Promise.resolve("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
      case "dispatch_nostr_event":
        return Promise.resolve({
          id: "7f3a9921b4a081cd84e03b9b4f9a0c1e556488d014bc089148d904b77f884210",
          pubkey: "e1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80",
          created_at: 1700000000,
          kind: args?.kind ?? 1,
          tags: args?.tags ?? [],
          content: args?.content ?? "",
          sig: "11223344",
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
}));

describe("GovernanceAuditor Phase 10", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    vi.restoreAllMocks();
  });

  it("defaults to Blossom snapshot mode and fetches/audits vote records", async () => {
    const mockSnapshot = {
      poll_id: "poll-101",
      title: "Consensus Governance Quorum",
      asserted_merkle_root: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      votes: [
        {
          poll_id: "poll-101",
          option_id: "opt_yes",
          client_signature: "sig123",
          voter_did: "did:key:z6Mkvoter1",
          network_timestamp: 1700000000,
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSnapshot),
      }),
    );

    render(<GovernanceAuditor />);

    expect(screen.getByText(/Blossom Snapshot \(BUD-01 Primary Source\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Legacy IPFS Gateway/i)).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/Paste 64-character SHA-256 snapshot hash/i);
    await act(async () => {
      fireEvent.change(input, {
        target: { value: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90" },
      });
    });

    const fetchBtn = screen.getByRole("button", { name: /Fetch Blossom Snapshot/i });
    await act(async () => {
      fireEvent.click(fetchBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Consensus Governance Quorum")).toBeInTheDocument();
      expect(screen.getByText("poll-101")).toBeInTheDocument();
    });

    // Audit ballots
    const auditBtn = screen.getByRole("button", { name: /Audit Ballots Locally/i });
    await act(async () => {
      fireEvent.click(auditBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("calculate_vote_merkle_root", {
        records: mockSnapshot.votes,
      });
      expect(screen.getByText("✓ Cryptographically Verified")).toBeInTheDocument();
      expect(screen.getByText("Merkle Match")).toBeInTheDocument();
      expect(screen.getByText(/Computed Root \(Local Audit\)/i)).toBeInTheDocument();
    });
  });
});

describe("QuickDispatchModal Phase 10", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("dispatches a Kind 1 note successfully", async () => {
    const onClose = vi.fn();
    render(<QuickDispatchModal isOpen={true} onClose={onClose} />);

    expect(screen.getByText(/Quick Dispatcher/i)).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/What's happening across the sovereign mesh/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Hello sovereign world!" } });
    });

    const dispatchBtn = screen.getByRole("button", { name: /Dispatch Note/i });
    await act(async () => {
      fireEvent.click(dispatchBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("dispatch_nostr_event", expect.objectContaining({
        kind: 1,
        content: "Hello sovereign world!",
        tags: [],
      }));
      expect(screen.getByText(/Event published to mesh/i)).toBeInTheDocument();
    });
  });

  it("dispatches a Kind 30023 civic poll with options and fidelity selector", async () => {
    const onClose = vi.fn();
    render(<QuickDispatchModal isOpen={true} onClose={onClose} />);

    const pollTabBtn = screen.getByRole("button", { name: /Civic Poll/i });
    await act(async () => {
      fireEvent.click(pollTabBtn);
    });

    const titleInput = screen.getByPlaceholderText(/Upgrade quorum threshold/i);
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: "Quorum 66% Consensus Vote" } });
    });

    const addOptBtn = screen.getByRole("button", { name: /\+ Add Option/i });
    await act(async () => {
      fireEvent.click(addOptBtn);
    });

    const createPollBtn = screen.getByRole("button", { name: /Create Civic Poll/i });
    await act(async () => {
      fireEvent.click(createPollBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("dispatch_nostr_event", expect.objectContaining({
        kind: 30023,
      }));
      expect(screen.getByText(/Civic Poll published to mesh/i)).toBeInTheDocument();
    });
  });
});

describe("SovereignFootprint Phase 10", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("loads and displays the ecosystem footprint cards and metrics", async () => {
    render(<SovereignFootprint />);

    await waitFor(() => {
      expect(screen.getByText(/Sovereign Ecosystem Footprint/i)).toBeInTheDocument();
      expect(screen.getByText(/7 registered ledgers/i)).toBeInTheDocument();
    });

    expect(screen.getByText("Social Footprint")).toBeInTheDocument();
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(screen.getByText("Governance Footprint")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText("Evidence Vault")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("Kinship Registry")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Media Vault")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText(/2 MB/i)).toBeInTheDocument();
  });
});

describe("GlobalStatusBar Phase 10", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("renders Dispatch button and opens QuickDispatchModal on click", async () => {
    const onNavigate = vi.fn();
    render(<GlobalStatusBar onNavigateEnclave={onNavigate} />);

    await waitFor(() => {
      expect(screen.getByText(/Primary Persona/i)).toBeInTheDocument();
    });

    const dispatchBtn = screen.getByRole("button", { name: /Dispatch/i });
    expect(dispatchBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(dispatchBtn);
    });

    expect(screen.getByText(/Quick Dispatcher/i)).toBeInTheDocument();
    expect(screen.getByText(/Dual-Broadcast to Local Relay & Mesh Nodes/i)).toBeInTheDocument();
  });

  it("renders active persona pill dynamically from props", async () => {
    const onNavigate = vi.fn();
    const l2Persona: Profile = {
      profile_id: "burner_99",
      profile_name: "DAD_BOD",
      derivation_index: 2,
      did: "did:key:z6MkjBurnerDidForTestingPill",
      level: 2,
      is_system_reserved: false,
      active: true,
      nostr_pubkey_hex: "abcdef1234567890abcdef1234567890abcdef12",
    };

    const { rerender } = render(
      <GlobalStatusBar onNavigateEnclave={onNavigate} activeProfile={l2Persona} />
    );

    expect(screen.getByText("DAD_BOD (L2)")).toBeInTheDocument();
    expect(screen.getByText("🎭")).toBeInTheDocument();
    expect(screen.getByText("did:key:z6MkjBur...")).toBeInTheDocument();

    const l1Persona: Profile = {
      profile_id: "primary",
      profile_name: "Primary Identity",
      derivation_index: 1,
      did: "did:key:z6MktL1PrimaryDid",
      level: 1,
      is_system_reserved: false,
      active: true,
    };

    rerender(<GlobalStatusBar onNavigateEnclave={onNavigate} activeProfile={l1Persona} />);
    expect(screen.getByText("Primary Identity (L1)")).toBeInTheDocument();
    expect(screen.getByText("👤")).toBeInTheDocument();
  });
});

describe("Reactive Persona Switching in QuickDispatchModal", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("renders identity badge for active persona and signs with persona profile_id", async () => {
    const l2Persona: Profile = {
      profile_id: "burner_matrix_2",
      profile_name: "CYBER_ANON",
      derivation_index: 2,
      did: "did:key:z6MkjCyberAnon",
      level: 2,
      is_system_reserved: false,
      active: true,
      nostr_pubkey_hex: "0123456789abcdef0123456789abcdef",
    };

    const onClose = vi.fn();
    render(<QuickDispatchModal isOpen={true} onClose={onClose} activeProfile={l2Persona} />);

    expect(screen.getByText(/Posting as:/i)).toBeInTheDocument();
    expect(screen.getByText("[CYBER_ANON (L2)]")).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText(/What's happening across the sovereign mesh/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Anonymous dispatch note" } });
    });

    const dispatchBtn = screen.getByRole("button", { name: /Dispatch Note/i });
    await act(async () => {
      fireEvent.click(dispatchBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("dispatch_nostr_event", {
        kind: 1,
        content: "Anonymous dispatch note",
        tags: [],
        profileId: "burner_matrix_2",
      });
    });
  });
});

describe("SovereignFootprint Core 8 & Extended Mesh", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("renders Core 8 satellite cards including safe, talk, and clar", async () => {
    render(<SovereignFootprint />);

    expect(await screen.findByText("Social Footprint")).toBeInTheDocument();
    expect(screen.getByText("Governance Footprint")).toBeInTheDocument();
    expect(screen.getByText("Evidence Vault")).toBeInTheDocument();
    expect(screen.getByText("Kinship Registry")).toBeInTheDocument();
    expect(screen.getByText("Media Vault")).toBeInTheDocument();
    expect(screen.getByText("Safety Circles & Beacons")).toBeInTheDocument();
    expect(screen.getByText("Support Rooms & Journals")).toBeInTheDocument();
    expect(screen.getByText("Creator Bookmarks & Ranks")).toBeInTheDocument();

    expect(screen.getByText("iyou_safe")).toBeInTheDocument();
    expect(screen.getByText("iyou_talk")).toBeInTheDocument();
    expect(screen.getByText("iyou_clar")).toBeInTheDocument();
  });

  it("expands and collapses the Extended Mesh (+5) drawer", async () => {
    render(<SovereignFootprint />);

    expect(await screen.findByText("Social Footprint")).toBeInTheDocument();
    expect(screen.queryByText("Extended Mesh Ecosystem (+5 Satellites)")).not.toBeInTheDocument();

    const toggleBtn = screen.getByRole("button", { name: /Extended Mesh \(\+5\)/i });
    await act(async () => {
      fireEvent.click(toggleBtn);
    });

    expect(screen.getByText("Extended Mesh Ecosystem (+5 Satellites)")).toBeInTheDocument();
    expect(screen.getByText("Vector Canvas & Art")).toBeInTheDocument();
    expect(screen.getByText("P2P Mobility & Fleet")).toBeInTheDocument();
    expect(screen.getByText("Local Havens & Sanctuaries")).toBeInTheDocument();
    expect(screen.getByText("Harvest Direct Commons")).toBeInTheDocument();
    expect(screen.getByText("Long-Form Publishing")).toBeInTheDocument();

    expect(screen.getByText("iyou_draw")).toBeInTheDocument();
    expect(screen.getByText("iyou_ride")).toBeInTheDocument();
    expect(screen.getByText("iyou_stay")).toBeInTheDocument();
    expect(screen.getByText("iyou_farm")).toBeInTheDocument();
    expect(screen.getByText("iyou_blog")).toBeInTheDocument();

    // Collapse again
    const collapseBtn = screen.getByRole("button", { name: /Collapse Extended Mesh/i });
    await act(async () => {
      fireEvent.click(collapseBtn);
    });

    expect(screen.queryByText("Extended Mesh Ecosystem (+5 Satellites)")).not.toBeInTheDocument();
  });
});

