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
import App from "../App";
import { DEFAULT_USER_PREFERENCES } from "../lib/types";
import { sha256Hex } from "../lib/appLock";

const { mockInvoke, mockOpen, defaultMockHandler } = vi.hoisted(() => {
  const mockOpen = vi.fn().mockResolvedValue(null);
  const handler = (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_vault_status":
        return Promise.resolve("Ready");
      case "get_user_preferences":
        return Promise.resolve({
          active_profile_id: "primary",
          default_signing_profile: "primary",
          auto_sign: false,
          last_active_tab: "enclave",
          active_sovereign_did: null,
          last_synced_at: 0,
          // A Ready vault (post-gateway) has completed the seed ceremony.
          seed_backup_confirmed: true,
          app_lock_enabled: false,
          inactivity_timeout_minutes: 15,
          signing_grace_period_minutes: 0,
          app_lock_pin_hash: null,
          app_lock_prf_hash: null,
          last_backup_at: 0,
          relay_mesh: ["wss://relay.iyou.me"],
        });
      case "get_auto_start_settings":
        return Promise.resolve({ Blossom: true, Nostr: true, Chat: true });
      case "get_service_statuses":
        return Promise.resolve({
          SigBridge: "running",
          Blossom: "stopped",
          Nostr: "stopped",
          Chat: "stopped",
        });
      case "toggle_service":
        return new Promise((resolve) =>
          setTimeout(
            () => resolve(args?.action === "stop" ? "stopped" : "running"),
            0,
          ),
        );
      case "get_active_did":
        return Promise.resolve("did:key:z6Mku...");
      case "get_active_profile":
        return Promise.resolve({
          profile_id: "primary",
          profile_name: "Primary Identity",
          derivation_index: 1,
          did: "did:key:z6Mku...",
          credentials: [],
          nostr_pubkey_hex: "00",
          level: 1,
          is_system_reserved: false,
          active: true,
        });
      case "get_tls_status":
        return Promise.resolve({
          is_production_cert: true,
          domain: "home.iyou.me",
          cert_path: "/mock/certs/production.crt",
        });
      case "list_profiles":
        return Promise.resolve([
          {
            profile_id: "primary",
            profile_name: "Primary Identity",
            derivation_index: 1,
            did: "did:key:z6Mku...",
            credentials: [],
            nostr_pubkey_hex: "00",
            level: 1,
            is_system_reserved: false,
          },
        ]);
      case "get_sync_status":
        return Promise.resolve({
          last_synced_at: 1756241000,
          local_notes_count: 14,
          local_blobs_count: 2,
        });
      case "trigger_manual_sync":
        return Promise.resolve({
          events_ingested: 14,
          blobs_mirrored: 2,
          last_synced_at: 1756241000,
        });
      case "revoke_all_sessions":
        return Promise.resolve("All active web sessions revoked successfully.");
      case "get_credentials":
        return Promise.resolve([]);
      case "import_verifiable_credential":
        return Promise.resolve({
          profile_id: "primary",
          profile_name: "Primary Identity",
          derivation_index: 1,
          did: "did:key:z6Mku...",
          credentials: [],
          nostr_pubkey_hex: "00",
          level: 1,
          is_system_reserved: false,
        });
      case "get_enclave_diagnostics":
        return Promise.resolve({
          type: "ENCLAVE_DIAGNOSTIC_RESPONSE",
          status: "ok",
          timestamp: 1756241000,
          key_custody: {
            initialized: true,
            anchor_initialized: true,
            public_persona_initialized: true,
            active_did: "did:key:z6Mku...",
            profile_count: 1,
            sovereign_identities_count: 0,
            status: "active",
          },
          local_ingress_relay: {
            service_name: "Nostr",
            port: 9003,
            running: false,
            db_exists: false,
            events_count: 0,
            status: "stopped",
          },
          local_media_server: {
            service_name: "Blossom",
            port: 9002,
            protocol: "BUD-01",
            running: false,
            blobs_count: 0,
            storage_bytes: 0,
            status: "stopped",
          },
          relay_gossip_mesh: {
            relays: ["wss://relay.iyou.me", "wss://nos.lol", "wss://relay.damus.io"],
            min_required: 3,
            configured_count: 3,
            mesh_ready: true,
            status: "healthy",
          },
          encrypted_backups: {
            last_backup_at: 1756241000,
            days_since_backup: 1,
            is_fresh: true,
            seed_backup_confirmed: true,
            status: "fresh",
          },
          all_capabilities_met: false,
        });
      default:
        return Promise.resolve();
    }
  };
  const mockInvoke = vi.fn(handler);
  return { mockInvoke, mockOpen, defaultMockHandler: handler };
});

const eventListeners: Record<string, ((event: any) => void)[]> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  Channel: vi.fn().mockImplementation(() => ({
    onmessage: null,
  })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (event: any) => void) => {
    if (!eventListeners[event]) {
      eventListeners[event] = [];
    }
    eventListeners[event].push(handler);
    return Promise.resolve(() => {
      eventListeners[event] = (eventListeners[event] || []).filter((h) => h !== handler);
    });
  }),
  emit: vi.fn((event: string, payload?: any) => {
    eventListeners[event]?.forEach((h) => h({ payload }));
    return Promise.resolve();
  }),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpen,
}));

describe("App", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(defaultMockHandler);
    mockOpen.mockReset();
    mockOpen.mockResolvedValue(null);
    Object.keys(eventListeners).forEach((k) => delete eventListeners[k]);
  });

  /** Mount App with the default "Ready" vault and wait for the boot query to
   *  resolve so the main tabs are mounted before assertions. */
  const renderReadyApp = async () => {
    render(<App />);
    await waitFor(() => {
      expect(document.querySelector(".tabs")).toBeInTheDocument();
    });
  };

  it("renders all main tabs", async () => {
    await renderReadyApp();
    // Tab buttons are inside .tabs container; status bar also has button text matching "Enclave"
    const tabs = document.querySelector(".tabs");
    expect(tabs?.textContent).toContain("Messages");
    expect(tabs?.textContent).toContain("Enclave");
    expect(tabs?.textContent).toContain("Credentials");
    expect(tabs?.textContent).toContain("Vault");
    expect(tabs?.textContent).toContain("Services");
    expect(tabs?.textContent).toContain("Governance");
  });

  it("navigates to the Messages tab and renders the split-pane inbox", async () => {
    await renderReadyApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Messages/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByText("Select a conversation or start a new encrypted chat"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Start New Chat/i })).toBeInTheDocument();
    });
  });

  it("defaults to Enclave tab on launch", async () => {
    await renderReadyApp();
    const tabs = document.querySelector(".tabs");
    const enclaveTab = tabs?.querySelector("button.active");
    expect(enclaveTab).toBeTruthy();
    expect(enclaveTab?.textContent).toContain("Enclave");
  });

  it("renders status bar with daemon indicators", async () => {
    await renderReadyApp();
    expect(screen.getByText("iyou_home")).toBeInTheDocument();
    expect(screen.getByText("SigBridge")).toBeInTheDocument();
    expect(screen.getByText("Nostr")).toBeInTheDocument();
    expect(screen.getByText("Blossom")).toBeInTheDocument();
  });

  it("navigates to Services tab and renders service list", async () => {
    await renderReadyApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Services/i }));
    });

    expect(screen.getByRole("heading", { name: "Services" })).toBeInTheDocument();
    expect(screen.getAllByText("SigBridge").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Blossom").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Nostr").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Routes external signing requests to your local vault")).toBeInTheDocument();
  });

  it("calls the toggle_service command when a start button is clicked", async () => {
    await renderReadyApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Services/i }));
    });

    const startButtons = screen.getAllByRole("button", {
      name: /^start$/i,
    });
    expect(startButtons.length).toBe(3);

    await act(async () => {
      fireEvent.click(startButtons[0]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("toggle_service", {
        name: "Blossom",
        action: "start",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });
  });

  it("handles service stop correctly", async () => {
    await renderReadyApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Services/i }));
    });

    const startButtons = screen.getAllByRole("button", {
      name: /^start$/i,
    });
    await act(async () => {
      fireEvent.click(startButtons[0]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });

    const stopButton = screen.getByText("Stop");
    await act(async () => {
      fireEvent.click(stopButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("toggle_service", {
        name: "Blossom",
        action: "stop",
      });
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /^start$/i }).length).toBe(3);
    });
  });

  it("renders Developer Mode toggle in footer", async () => {
    await renderReadyApp();
    expect(screen.getByText("Developer Mode")).toBeInTheDocument();
  });

  it("Developer Mode toggle shows Manual Signer tab", async () => {
    await renderReadyApp();

    // Manual Signer tab should not be visible by default
    expect(screen.queryByRole("button", { name: /Manual Signer/i })).not.toBeInTheDocument();

    // Toggle dev mode
    const devToggle = screen.getByText("Developer Mode");
    await act(async () => {
      fireEvent.click(devToggle);
    });

    // Manual Signer tab should now be visible
    expect(screen.getByRole("button", { name: /Manual Signer/i })).toBeInTheDocument();
  });

  it("navigates to Enclave tab and shows Project Zero", async () => {
    render(<App />);

    // Enclave is default — should already show Project Zero content
    await waitFor(() => {
      expect(screen.getByText("Project Zero")).toBeInTheDocument();
    });
  });

  it("renders Sync to Home card in Services tab and handles manual sync", async () => {
    await renderReadyApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Services/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Sync to Home/i)).toBeInTheDocument();
      expect(screen.getByText(/Notes: 14 \| Blobs: 2/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Sync Now/i })).toBeInTheDocument();
    });

    const syncNowButton = screen.getByRole("button", { name: /Sync Now/i });
    await act(async () => {
      fireEvent.click(syncNowButton);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("trigger_manual_sync");
      expect(mockInvoke).toHaveBeenCalledWith("get_sync_status");
    });
  });

  it("renders Sync indicator in global status bar", async () => {
    await renderReadyApp();
    expect(screen.getByText("Sync")).toBeInTheDocument();
  });

  it("navigates to Vault tab, renders redundancy banner and handles session revocation", async () => {
    await renderReadyApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Vault/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Sovereign Data Redundancy/i)).toBeInTheDocument();
      expect(screen.getByText(/Active Web Sessions/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Revoke All Web Sessions/i })).toBeInTheDocument();
    });

    const revokeBtn = screen.getByRole("button", { name: /Revoke All Web Sessions/i });
    await act(async () => {
      fireEvent.click(revokeBtn);
    });

    await waitFor(() => {
      expect(screen.getByText(/Confirm Global Session Revocation/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Confirm Revocation/i })).toBeInTheDocument();
    });

    const confirmBtn = screen.getByRole("button", { name: /Confirm Revocation/i });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("revoke_all_sessions");
      expect(screen.getByText(/All active web sessions revoked successfully/i)).toBeInTheDocument();
    });
  });

  it("navigates to Trust Assets tab, opens import modal and imports a credential", async () => {
    await renderReadyApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Credentials/i }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Sovereign Credential Repository/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /\+ Import Credential/i })).toBeInTheDocument();
    });

    const openImportBtn = screen.getByRole("button", { name: /\+ Import Credential/i });
    await act(async () => {
      fireEvent.click(openImportBtn);
    });

    await waitFor(() => {
      expect(screen.getByText(/Import Verifiable Credential/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Paste raw W3C Verifiable Credential/i)).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText(/Paste raw W3C Verifiable Credential/i);
    await act(async () => {
      fireEvent.change(textarea, {
        target: {
          value: JSON.stringify({
            "@context": ["https://www.w3.org/2018/credentials/v1"],
            "type": ["VerifiableCredential"],
            "issuer": "did:key:z123",
            "credentialSubject": { "id": "did:key:z456" },
            "proof": { "sig": "abc" },
          }),
        },
      });
    });

    const submitBtn = screen.getByRole("button", { name: /Verify & Save to Vault/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "import_verifiable_credential",
        expect.objectContaining({
          vcPayload: expect.stringContaining("VerifiableCredential"),
        }),
      );
      expect(screen.getByText(/Credential imported successfully/i)).toBeInTheDocument();
    });
  });

  it("renders FirstRunSeedGate overlay for legacy Ready vaults with an unconfirmed seed backup", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_vault_status") return Promise.resolve("Ready");
      if (cmd === "get_user_preferences")
        return Promise.resolve({
          ...DEFAULT_USER_PREFERENCES,
          seed_backup_confirmed: false,
        });
      if (cmd === "reveal_master_seed")
        return Promise.resolve(
          "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        );
      return defaultMockHandler(cmd, args);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Master Seed Backup/i)).toBeInTheDocument();
    });
  });

  it("renders AppLockOverlay when app_lock_enabled is set and unlocks on valid PIN", async () => {
    const pin = "123456";
    const pinHash = await sha256Hex(pin);
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_vault_status") return Promise.resolve("Ready");
      if (cmd === "get_user_preferences")
        return Promise.resolve({
          ...DEFAULT_USER_PREFERENCES,
          seed_backup_confirmed: true,
          app_lock_enabled: true,
          app_lock_pin_hash: pinHash,
        });
      return defaultMockHandler(cmd, args);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("iyou_home is locked")).toBeInTheDocument();
    });

    const pinInput = screen.getByPlaceholderText("••••••");
    const unlockBtn = screen.getByRole("button", { name: "Unlock" });

    await act(async () => {
      fireEvent.change(pinInput, { target: { value: pin } });
    });

    await act(async () => {
      fireEvent.click(unlockBtn);
    });

    await waitFor(() => {
      expect(screen.queryByText("iyou_home is locked")).not.toBeInTheDocument();
    });
  });

  it("locks the app upon receiving the native tray app://lock event", async () => {
    render(<App />);

    await waitFor(() => {
      expect(eventListeners["app://lock"]?.length).toBeGreaterThan(0);
    });

    await act(async () => {
      eventListeners["app://lock"]?.forEach((h) => h({}));
    });

    await waitFor(() => {
      expect(screen.getByText("iyou_home is locked")).toBeInTheDocument();
    });
  });

  // ---------- First-run onboarding gateway ----------

  it("renders the FirstRunGateway and hides main tabs when the vault is Uninitialized", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_vault_status") return Promise.resolve("Uninitialized");
      return defaultMockHandler(cmd, args);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("first-run-gateway")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /Create Sovereign Identity/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Sync \/ Restore Existing Device/i }),
    ).toBeInTheDocument();
    // No main navigation while uninitialized.
    expect(document.querySelector(".tabs")).not.toBeInTheDocument();
    expect(screen.queryByText("Developer Mode")).not.toBeInTheDocument();
  });

  it("Create flow: generate_did, then locked seed ceremony before entering the app", async () => {
    const SEED = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    let status: string = "Uninitialized";
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_vault_status") return Promise.resolve(status);
      if (cmd === "generate_did") {
        status = "Ready"; // bootstrapping the vault flips the disk state
        return Promise.resolve("did:key:z6Mku...");
      }
      if (cmd === "reveal_master_seed") return Promise.resolve(SEED);
      return defaultMockHandler(cmd, args);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("first-run-gateway")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Create Sovereign Identity/i }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("gateway-seed-ceremony")).toBeInTheDocument();
      expect(screen.getByText(/Write Down Your Recovery Seed/i)).toBeInTheDocument();
    });

    // The confirmation button must be disabled until the ceremony completes.
    const confirmSeed = screen.getByTestId("gateway-confirm-seed");
    expect(confirmSeed).toBeDisabled();
    // Seed chunks are rendered for the word challenge (default ceremony mode).
    expect(document.querySelectorAll("[data-chunk-index]").length).toBeGreaterThan(0);

    // Switch to the typed-acknowledgment path, which is the primary proof
    // required before the vault handoff.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Use the typed acknowledgment instead/i }),
      );
    });
    expect(screen.getByTestId("gateway-ack-input")).toBeInTheDocument();

    // The ack phrase unlocks the ceremony on the typed path.
    await act(async () => {
      fireEvent.change(screen.getByTestId("gateway-ack-input"), {
        target: { value: "I HAVE WRITTEN THIS DOWN" },
      });
    });
    await waitFor(() => {
      expect(confirmSeed).not.toBeDisabled();
    });
    await act(async () => {
      fireEvent.click(confirmSeed);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("set_seed_backup_confirmed", {
        confirmed: true,
      });
      expect(mockInvoke).toHaveBeenCalledWith("start_ready_services");
    });

    // Gateway unmounts and the main app appears.
    await waitFor(() => {
      expect(document.querySelector(".tabs")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("first-run-gateway")).not.toBeInTheDocument();
  });

  it("restore-from-seed flow calls bootstrap_from_seed and enters the app", async () => {
    const SEED = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    let status: string = "Uninitialized";
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_vault_status") return Promise.resolve(status);
      if (cmd === "bootstrap_from_seed") {
        status = "Ready";
        return Promise.resolve("did:key:z6Mku...");
      }
      return defaultMockHandler(cmd, args);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("first-run-gateway")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Sync \/ Restore Existing Device/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("gateway-restore-seed"));
    });
    expect(screen.getByTestId("gateway-restore-seed-panel")).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByTestId("gateway-seed-input"), {
        target: { value: SEED },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("gateway-restore-seed-confirm"));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("bootstrap_from_seed", {
        seedPhraseOrHex: SEED,
      });
      expect(mockInvoke).toHaveBeenCalledWith("start_ready_services");
    });
    await waitFor(() => {
      expect(document.querySelector(".tabs")).toBeInTheDocument();
    });
  });

  it("restore-from-backup flow reads the archive, restores it, and enters the app", async () => {
    let status: string = "Uninitialized";
    mockOpen.mockResolvedValue("/tmp/iyou_home_restore.iyoubackup");
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_vault_status") return Promise.resolve(status);
      if (cmd === "read_binary_file") return Promise.resolve([1, 2, 3, 4]);
      if (cmd === "restore_vault_backup") {
        status = "Ready";
        return Promise.resolve(true);
      }
      return defaultMockHandler(cmd, args);
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("first-run-gateway")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Sync \/ Restore Existing Device/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("gateway-restore-backup"));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("read_binary_file", {
        path: "/tmp/iyou_home_restore.iyoubackup",
      });
      expect(screen.getByTestId("gateway-restore-backup-panel")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("gateway-backup-password"), {
        target: { value: "hunter2" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("gateway-restore-backup-confirm"));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("restore_vault_backup", {
        backupBytes: [1, 2, 3, 4],
        password: "hunter2",
      });
      expect(mockInvoke).toHaveBeenCalledWith("start_ready_services");
    });
    await waitFor(() => {
      expect(document.querySelector(".tabs")).toBeInTheDocument();
    });
  });
});
