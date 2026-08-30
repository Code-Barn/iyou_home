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
import UpdateVettingModal from "../components/updater/UpdateVettingModal";
import KeysManager from "../components/KeysManager";
import GlobalStatusBar from "../components/GlobalStatusBar";
import type { UpdateMetadata, UpdatePreferences } from "../lib/types";

const mockUpdateMetadata: UpdateMetadata = {
  current_version: "0.2.0",
  target_version: "0.2.1",
  git_commit_hash: "8f3b2a1c4e9d0e2f1a3b5c7d9e0f2a4b6c8d0e1f",
  binary_sha256: "4b9f2130e6dfb2ef784ac3690d70b77a0642f567812a809f456c6ef2e76f9012",
  minisign_signature: "untrusted comment: signature from minisign secret key\nRWQUVz81iYkLd...ByersBrandsSovereignReleaseKey/=\n",
  release_notes: "• Phase 11 & 12 Sovereign Updates\n• Minisign Release Vetting\n• One-Click Rollback",
  published_at: 1700000000,
  download_url: "https://updates.iyou.me/home/latest.json",
};

const mockUpdatePrefs: UpdatePreferences = {
  policy: "manual",
  release_channel: "stable",
  custom_manifest_url: null,
  last_checked_at: 1700000000,
  ignored_version: null,
};

let currentUpdate: UpdateMetadata | null = mockUpdateMetadata;
let currentPrefs: UpdatePreferences = mockUpdatePrefs;
let currentHasRollback = true;

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_update_preferences":
        return Promise.resolve(currentPrefs);
      case "set_update_preferences":
        if (args?.prefs) currentPrefs = args.prefs as UpdatePreferences;
        return Promise.resolve();
      case "check_for_update_vetting":
        return Promise.resolve(currentUpdate);
      case "install_vetted_update":
        return Promise.resolve();
      case "has_rollback_binary":
        return Promise.resolve(currentHasRollback);
      case "rollback_to_previous_binary":
        return Promise.resolve(true);
      case "get_service_statuses":
        return Promise.resolve({ SigBridge: "running", Nostr: "running", Blossom: "running" });
      case "list_profiles":
        return Promise.resolve([
          {
            profile_id: "primary",
            profile_name: "Primary Persona",
            did: "did:key:z6MkuTest123",
            level: 1,
            derivation_index: 1,
            is_system_reserved: false,
            active: true,
          },
        ]);
      case "get_active_did":
        return Promise.resolve("did:key:z6MkuTest123");
      case "get_sync_status":
        return Promise.resolve({ last_synced_at: 1700000000, local_notes_count: 5, local_blobs_count: 3 });
      case "get_user_preferences":
        return Promise.resolve({
          active_profile_id: "primary",
          default_signing_profile: "primary",
          auto_sign: false,
          last_active_tab: "enclave",
          update_preferences: currentPrefs,
        });
      default:
        return Promise.resolve();
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

describe("UpdateVettingModal Phase 12", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("renders cryptographic proofs, commit diff link, and version delta", () => {
    const onClose = vi.fn();
    render(
      <UpdateVettingModal
        isOpen={true}
        onClose={onClose}
        updateMetadata={mockUpdateMetadata}
      />
    );

    expect(screen.getByText("Cryptographic Release Vetting")).toBeInTheDocument();
    expect(screen.getByText("v0.2.0")).toBeInTheDocument();
    expect(screen.getByText("v0.2.1")).toBeInTheDocument();
    expect(screen.getByText("View Source Diff ↗")).toBeInTheDocument();
    expect(screen.getByText(/4b9f2130e6dfb2ef784ac3690d70b77a0642f567812a809f456c6ef2e76f9012/i)).toBeInTheDocument();
    expect(screen.getByText("✓ Verified Public Key")).toBeInTheDocument();
    expect(screen.getByText(/Phase 11 & 12 Sovereign Updates/i)).toBeInTheDocument();
  });

  it("toggles raw Minisign signature view", () => {
    const onClose = vi.fn();
    render(
      <UpdateVettingModal
        isOpen={true}
        onClose={onClose}
        updateMetadata={mockUpdateMetadata}
      />
    );

    const toggleBtn = screen.getByRole("button", { name: /View Raw ▾/i });
    fireEvent.click(toggleBtn);

    expect(screen.getByText(/untrusted comment: signature from minisign secret key/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hide Raw ▴/i })).toBeInTheDocument();
  });

  it("executes install_vetted_update when install button is clicked", async () => {
    const onClose = vi.fn();
    const onInstallComplete = vi.fn();
    render(
      <UpdateVettingModal
        isOpen={true}
        onClose={onClose}
        updateMetadata={mockUpdateMetadata}
        onInstallComplete={onInstallComplete}
      />
    );

    const installBtn = screen.getByRole("button", { name: /Verify & Install Update/i });
    await act(async () => {
      fireEvent.click(installBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("install_vetted_update", {
        targetVersion: "0.2.1",
      });
      expect(onInstallComplete).toHaveBeenCalled();
    });
  });
});

describe("KeysManager Update & Rollback Settings Phase 12", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    currentPrefs = { ...mockUpdatePrefs };
    currentHasRollback = true;
  });

  it("renders Software Updates & Verification card with update policies", async () => {
    render(<KeysManager />);

    expect(await screen.findByRole("heading", { name: /Software Updates & Verification/i })).toBeInTheDocument();
    expect(screen.getByText(/Air-Gapped \/ Locked/i)).toBeInTheDocument();
    expect(screen.getByText(/Manual Review/i)).toBeInTheDocument();
    expect(screen.getByText(/⚡ Automatic/i)).toBeInTheDocument();
  });

  it("updates policy preference when radio option changes", async () => {
    render(<KeysManager />);

    await waitFor(() => {
      expect(screen.getByText(/Air-Gapped \/ Locked/i)).toBeInTheDocument();
    });

    const airgapRadio = screen.getByRole("radio", { name: /Air-Gapped \/ Locked/i });
    await act(async () => {
      fireEvent.click(airgapRadio);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("set_update_preferences", {
        prefs: expect.objectContaining({ policy: "locked" }),
      });
    });
  });

  it("triggers check for updates and surfaces vetting modal", async () => {
    render(<KeysManager />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Check for Updates Now/i })).toBeInTheDocument();
    });

    const checkBtn = screen.getByRole("button", { name: /Check for Updates Now/i });
    await act(async () => {
      fireEvent.click(checkBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("check_for_update_vetting", { force: true });
      expect(screen.getByText("Cryptographic Release Vetting")).toBeInTheDocument();
    });
  });

  it("renders One-Click Binary Rollback button and executes rollback", async () => {
    render(<KeysManager />);

    await waitFor(() => {
      expect(screen.getByText("One-Click Binary Rollback")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Rollback to Previous Version/i })).toBeEnabled();
    });

    const rollbackBtn = screen.getByRole("button", { name: /Rollback to Previous Version/i });
    await act(async () => {
      fireEvent.click(rollbackBtn);
    });

    expect(screen.getByText("Confirm Binary Rollback")).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", { name: "Confirm Rollback" });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("rollback_to_previous_binary");
    });
  });
});

describe("GlobalStatusBar Update Notification Phase 12", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    currentUpdate = mockUpdateMetadata;
  });

  it("renders non-intrusive update badge in header and opens vetting modal on click", async () => {
    const onNavigate = vi.fn();
    render(<GlobalStatusBar onNavigateEnclave={onNavigate} />);

    await waitFor(() => {
      expect(screen.getByText("Update v0.2.1 Available")).toBeInTheDocument();
    });

    const badge = screen.getByText("Update v0.2.1 Available");
    await act(async () => {
      fireEvent.click(badge);
    });

    expect(screen.getByText("Cryptographic Release Vetting")).toBeInTheDocument();
  });
});
