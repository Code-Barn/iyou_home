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
import KeysManager from "../components/KeysManager";
import type { Profile, UserPreferences, UpdatePreferences } from "../lib/types";
import { DEFAULT_USER_PREFERENCES } from "../lib/types";

type InvokeArgs = Record<string, unknown>;

const PIN_123456_HASH = "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";

const { mockInvoke, mockWriteText, mockDialogOpen, mockDialogSave, state } = vi.hoisted(() => {
  const state = {
    activeDid: "did:key:z6MkuRootParentGuardian1234567890",
    profiles: [
      {
        profile_id: "primary",
        profile_name: "Primary Persona",
        did: "did:key:z6MkuRootParentGuardian1234567890",
        level: 0,
        derivation_index: 0,
        is_system_reserved: true,
        active: true,
      },
    ] as Profile[],
    dependents: [] as unknown[],
    revealedHexSeed: "4a8e2b9c1d0f3e5a7b9c1d0f3e5a7b9c1d0f3e5a7b9c1d0f3e5a7b9c1d0f3e5a",
    calls: [] as { cmd: string; args?: InvokeArgs }[],
  };

  const mockInvoke = vi.fn((cmd: string, args?: InvokeArgs) => {
    state.calls.push({ cmd, args });
    switch (cmd) {
      case "get_active_did":
        return Promise.resolve(state.activeDid);
      case "list_profiles":
        return Promise.resolve(state.profiles);
      case "get_update_preferences":
        return Promise.resolve({
          policy: "manual",
          release_channel: "stable",
          custom_manifest_url: null,
          last_checked_at: null,
          ignored_version: null,
        } as UpdatePreferences);
      case "has_rollback_binary":
        return Promise.resolve(true);
      case "reveal_master_seed":
        return Promise.resolve(state.revealedHexSeed);
      case "verify_biometric_auth":
        return Promise.resolve(true);
      case "create_vault_backup":
        return Promise.resolve([1, 2, 3, 4, 5]);
      case "write_binary_file":
        return Promise.resolve();
      case "read_binary_file":
        return Promise.resolve([1, 2, 3, 4, 5]);
      case "restore_vault_backup":
        return Promise.resolve();
      case "revoke_all_sessions":
        return Promise.resolve("OK");
      case "list_dependents":
        return Promise.resolve(state.dependents);
      case "set_update_preferences":
        return Promise.resolve();
      case "render_qr_code":
        return Promise.resolve("data:image/png;base64,mockqr");
      default:
        return Promise.resolve(null);
    }
  });

  const mockWriteText = vi.fn().mockResolvedValue(undefined);
  const mockDialogOpen = vi.fn().mockResolvedValue("/path/to/backup.iyoubackup");
  const mockDialogSave = vi.fn().mockResolvedValue("/path/to/exported.iyoubackup");

  return { mockInvoke, mockWriteText, mockDialogOpen, mockDialogSave, state };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mockWriteText,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockDialogOpen,
  save: mockDialogSave,
}));

describe("KeysManager Three-Pillar Architecture & Security Controls", () => {
  const defaultPrefs: UserPreferences = {
    ...DEFAULT_USER_PREFERENCES,
    app_lock_enabled: false,
    app_lock_pin_hash: null,
    app_lock_prf_hash: null,
  };

  beforeEach(() => {
    mockInvoke.mockClear();
    mockWriteText.mockClear();
    mockDialogOpen.mockClear();
    mockDialogSave.mockClear();
    state.calls = [];
  });

  describe("Pillar Layout Restructuring", () => {
    it("renders the three structured pillar containers", async () => {
      render(<KeysManager prefs={defaultPrefs} />);

      expect(await screen.findByTestId("pillar-family-devices")).toBeInTheDocument();
      expect(screen.getByTestId("pillar-enclave-security")).toBeInTheDocument();
      expect(screen.getByTestId("pillar-redundancy-updates")).toBeInTheDocument();

      // Titles
      expect(screen.getByText(/Family & Companion Devices/i)).toBeInTheDocument();
      expect(screen.getByText(/Enclave Security & Access/i)).toBeInTheDocument();
      expect(screen.getByText(/Redundancy, Storage & Updates/i)).toBeInTheDocument();
    });

    it("mounts companion pairing and family dependents inside Pillar 1", async () => {
      render(<KeysManager prefs={defaultPrefs} />);

      const pillar1 = await screen.findByTestId("pillar-family-devices");
      expect(pillar1).toBeInTheDocument();

      // Device Pairing action
      expect(screen.getByTestId("pair-mobile-device-btn")).toBeInTheDocument();

      // Dependents Manager empty state rendered inside pillar 1
      expect(screen.getByTestId("dependents-empty")).toBeInTheDocument();
    });

    it("enforces Emancipation Guard: never renders emancipation trigger on root adult/guardian persona", async () => {
      render(
        <KeysManager
          prefs={defaultPrefs}
          activeProfile={{
            profile_id: "primary",
            profile_name: "Primary Persona",
            did: "did:key:z6MkuRootParentGuardian1234567890",
            level: 0,
            derivation_index: 0,
            is_system_reserved: true,
            active: true,
          }}
        />
      );

      await screen.findByTestId("pillar-family-devices");

      // Verify no emancipate button appears anywhere on the root persona or general UI
      expect(screen.queryByText(/Emancipate \(18\+ \/ graduate\)/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Confirm Emancipation/i)).not.toBeInTheDocument();
    });
  });

  describe("Hardened Master Seed Reveal (Pillar 2)", () => {
    it("requires PIN challenge when App Lock is enabled and fails closed on incorrect PIN", async () => {
      const lockedPrefs: UserPreferences = {
        ...defaultPrefs,
        app_lock_enabled: true,
        app_lock_pin_hash: PIN_123456_HASH,
      };

      render(<KeysManager prefs={lockedPrefs} />);

      const revealBtn = await screen.findByTestId("reveal-master-seed-btn");
      fireEvent.click(revealBtn);

      expect(await screen.findByTestId("seed-reveal-modal")).toBeInTheDocument();
      expect(screen.getByTestId("seed-pin-input")).toBeInTheDocument();

      // Enter incorrect PIN
      const pinInput = screen.getByTestId("seed-pin-input");
      fireEvent.change(pinInput, { target: { value: "999999" } });

      const submitBtn = screen.getByTestId("seed-pin-submit");
      fireEvent.click(submitBtn);

      // Must fail closed and not call reveal_master_seed
      await waitFor(() => {
        expect(screen.getByTestId("seed-pin-error")).toHaveTextContent(/Incorrect PIN/i);
      });
      expect(mockInvoke).not.toHaveBeenCalledWith("reveal_master_seed");
      expect(screen.queryByTestId("revealed-seed-text")).not.toBeInTheDocument();

      // Enter correct PIN "123456"
      fireEvent.change(pinInput, { target: { value: "123456" } });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("reveal_master_seed");
      });

      // Revealed seed is displayed
      const seedDisplay = await screen.findByTestId("revealed-seed-text");
      expect(seedDisplay).toHaveTextContent(state.revealedHexSeed);

      // Countdown timer is present
      expect(screen.getByTestId("seed-timer-countdown")).toHaveTextContent("30s");

      // One-click copy seed
      const copyBtn = screen.getByTestId("copy-master-seed");
      fireEvent.click(copyBtn);

      await waitFor(() => {
        expect(mockWriteText).toHaveBeenCalledWith(state.revealedHexSeed);
      });
      expect(screen.getByText("Copied!")).toBeInTheDocument();
    });

    it("supports biometric verification if enrolled during seed revelation", async () => {
      const biometricPrefs: UserPreferences = {
        ...defaultPrefs,
        app_lock_enabled: true,
        app_lock_pin_hash: PIN_123456_HASH,
        app_lock_prf_hash: "mock_prf_seed_hash_abcdef",
      };

      render(<KeysManager prefs={biometricPrefs} />);

      const revealBtn = await screen.findByTestId("reveal-master-seed-btn");
      fireEvent.click(revealBtn);

      const biometricBtn = await screen.findByTestId("seed-biometric-verify");
      fireEvent.click(biometricBtn);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("verify_biometric_auth", {
          reason: "Verify biometrics to reveal master seed",
        });
        expect(mockInvoke).toHaveBeenCalledWith("reveal_master_seed");
      });

      expect(await screen.findByTestId("revealed-seed-text")).toBeInTheDocument();
    });

    it("requires phrase confirmation when App Lock is disabled", async () => {
      render(<KeysManager prefs={defaultPrefs} />);

      const revealBtn = await screen.findByTestId("reveal-master-seed-btn");
      fireEvent.click(revealBtn);

      expect(await screen.findByTestId("seed-reveal-modal")).toBeInTheDocument();
      expect(screen.queryByTestId("seed-pin-input")).not.toBeInTheDocument();

      const confirmInput = screen.getByTestId("seed-confirm-input");
      expect(confirmInput).toBeInTheDocument();

      const confirmBtn = screen.getByTestId("seed-confirm-btn");
      expect(confirmBtn).toBeDisabled();

      // Enter matching phrase
      fireEvent.change(confirmInput, { target: { value: "REVEAL MY SEED" } });
      expect(confirmBtn).not.toBeDisabled();

      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("reveal_master_seed");
      });

      expect(await screen.findByTestId("revealed-seed-text")).toBeInTheDocument();
    });

    it("provides session revocation kill-switch in Pillar 2", async () => {
      render(<KeysManager prefs={defaultPrefs} />);

      const killSwitchBtn = await screen.findByTestId("kill-switch-btn");
      fireEvent.click(killSwitchBtn);

      expect(await screen.findByTestId("kill-switch-modal")).toBeInTheDocument();

      const confirmBtn = screen.getByTestId("confirm-revoke-sessions-btn");
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("revoke_all_sessions");
      });

      expect(await screen.findByTestId("revoke-success-msg")).toBeInTheDocument();
    });
  });

  describe("Pillar 3: Redundancy, Storage & Updates", () => {
    it("renders unified sovereign backup card with export and restore triggers", async () => {
      render(<KeysManager prefs={defaultPrefs} />);

      expect(await screen.findByTestId("export-backup-btn")).toBeInTheDocument();
      expect(screen.getByTestId("restore-backup-btn")).toBeInTheDocument();

      // Sovereign guarantees collapsible
      const guarantees = screen.getByTestId("redundancy-guarantees-details");
      expect(guarantees).toBeInTheDocument();
      expect(guarantees).toHaveTextContent("Self-Contained SQLite");
      expect(guarantees).toHaveTextContent("XChaCha20-Poly1305 / AES-256");
      expect(guarantees).toHaveTextContent("Lossless Multi-Device Portability");
    });

    it("triggers export_encrypted_backup workflow with password encryption", async () => {
      render(<KeysManager prefs={defaultPrefs} />);

      const exportBtn = await screen.findByTestId("export-backup-btn");
      fireEvent.click(exportBtn);

      // Password modal appears
      expect(await screen.findByTestId("backup-password-modal")).toBeInTheDocument();
      const pwdInput = screen.getByTestId("backup-password-input");
      fireEvent.change(pwdInput, { target: { value: "SuperSecretPassphrase123" } });

      const downloadBtn = screen.getByTestId("confirm-download-backup-btn");
      fireEvent.click(downloadBtn);

      await waitFor(() => {
        expect(mockDialogSave).toHaveBeenCalled();
        expect(mockInvoke).toHaveBeenCalledWith("create_vault_backup", {
          password: "SuperSecretPassphrase123",
        });
        expect(mockInvoke).toHaveBeenCalledWith("write_binary_file", {
          path: "/path/to/exported.iyoubackup",
          contents: [1, 2, 3, 4, 5],
        });
      });
    });

    it("renders Danger Zone inside a collapsible details container", async () => {
      render(<KeysManager prefs={defaultPrefs} />);

      const dangerZone = await screen.findByTestId("danger-zone-details");
      expect(dangerZone).toBeInTheDocument();
      expect(screen.getByTestId("regenerate-vault-btn")).toBeInTheDocument();
      expect(screen.getByText("One-Click Binary Rollback")).toBeInTheDocument();
    });
  });
});
