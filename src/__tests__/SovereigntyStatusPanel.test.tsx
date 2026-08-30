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
import { vi } from "vitest";
import SovereigntyStatusPanel from "../components/SovereigntyStatusPanel";
import type { EnclaveDiagnostics } from "../lib/types";

const mockDiagnosticsFull: EnclaveDiagnostics = {
  type: "ENCLAVE_DIAGNOSTIC_RESPONSE",
  status: "ok",
  timestamp: 1700000000,
  key_custody: {
    initialized: true,
    anchor_initialized: true,
    public_persona_initialized: true,
    active_did: "did:key:z6MkuTestIdentityPublicPersonaKey12345",
    profile_count: 2,
    sovereign_identities_count: 1,
    status: "active",
  },
  local_ingress_relay: {
    service_name: "Nostr",
    port: 9003,
    running: true,
    db_exists: true,
    events_count: 42,
    status: "running",
  },
  local_media_server: {
    service_name: "Blossom",
    port: 9002,
    protocol: "BUD-01",
    running: true,
    blobs_count: 15,
    storage_bytes: 1048576,
    status: "running",
  },
  relay_gossip_mesh: {
    relays: [
      "wss://relay.iyou.me",
      "wss://nos.lol",
      "wss://relay.damus.io",
    ],
    min_required: 3,
    configured_count: 3,
    mesh_ready: true,
    status: "healthy",
  },
  encrypted_backups: {
    last_backup_at: 1700000000,
    days_since_backup: 2,
    is_fresh: true,
    seed_backup_confirmed: true,
    status: "fresh",
  },
  all_capabilities_met: true,
};

const mockDiagnosticsPartial: EnclaveDiagnostics = {
  type: "ENCLAVE_DIAGNOSTIC_RESPONSE",
  status: "ok",
  timestamp: 1700000000,
  key_custody: {
    initialized: true,
    anchor_initialized: true,
    public_persona_initialized: true,
    active_did: "did:key:z6MkuTestIdentityPublicPersonaKey12345",
    profile_count: 2,
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
    relays: [
      "wss://relay.iyou.me",
    ],
    min_required: 3,
    configured_count: 1,
    mesh_ready: false,
    status: "insufficient_relays",
  },
  encrypted_backups: {
    last_backup_at: 0,
    days_since_backup: null,
    is_fresh: false,
    seed_backup_confirmed: false,
    status: "never_exported",
  },
  all_capabilities_met: false,
};

let currentDiagnostics = mockDiagnosticsFull;

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_enclave_diagnostics":
        return Promise.resolve(currentDiagnostics);
      case "toggle_service":
        return Promise.resolve("running");
      case "add_mesh_relay":
        return Promise.resolve([
          "wss://relay.iyou.me",
          String(args?.relayUrl || "wss://custom.relay.io"),
        ]);
      case "remove_mesh_relay":
        return Promise.resolve(["wss://relay.iyou.me"]);
      case "reset_mesh_relays":
        return Promise.resolve([
          "wss://relay.iyou.me",
          "wss://nos.lol",
          "wss://relay.damus.io",
        ]);
      case "create_vault_backup":
        return Promise.resolve([1, 2, 3, 4]);
      case "record_backup_timestamp":
        return Promise.resolve(1700000000);
      default:
        return Promise.resolve();
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue("/tmp/test_backup.iyoubackup"),
}));

describe("SovereigntyStatusPanel", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    currentDiagnostics = mockDiagnosticsFull;
  });

  it("renders the 5 sovereignty checklist capabilities in sovereign state", async () => {
    render(<SovereigntyStatusPanel />);

    await waitFor(() => {
      expect(screen.getByText(/Private Enclave Sovereignty HUD/i)).toBeInTheDocument();
      expect(screen.getByText(/5\/5 Sovereign Enclave/i)).toBeInTheDocument();
      expect(screen.getByText(/Key Custody & Hardware Air-Gap/i)).toBeInTheDocument();
      expect(screen.getByText(/Local Ingress Relay \(Nostr NIP-01\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Local Media Server \(Blossom BUD-01 PDS\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Relay Gossip Mesh \(≥ 3 Independent Relays\)/i)).toBeInTheDocument();
      expect(screen.getByText(/Encrypted Vault Backups \(Freshness < 30 Days\)/i)).toBeInTheDocument();
    });
  });

  it("renders action buttons for unfulfilled checks in partial autonomy state", async () => {
    currentDiagnostics = mockDiagnosticsPartial;
    render(<SovereigntyStatusPanel />);

    await waitFor(() => {
      expect(screen.getByText(/Start Local Relay/i)).toBeInTheDocument();
      expect(screen.getByText(/Start Local Blossom/i)).toBeInTheDocument();
      expect(screen.getByText(/Export Backup/i)).toBeInTheDocument();
      expect(screen.getByText(/\+ Add Relay/i)).toBeInTheDocument();
    });
  });

  it("calls toggle_service when Start Local Relay button is clicked", async () => {
    currentDiagnostics = mockDiagnosticsPartial;
    const onServiceToggled = vi.fn();
    render(<SovereigntyStatusPanel onServiceToggled={onServiceToggled} />);

    await waitFor(() => {
      expect(screen.getByText(/Start Local Relay/i)).toBeInTheDocument();
    });

    const startRelayBtn = screen.getByText(/Start Local Relay/i);
    fireEvent.click(startRelayBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("toggle_service", {
        name: "Nostr",
        action: "start",
      });
      expect(onServiceToggled).toHaveBeenCalled();
    });
  });

  it("calls toggle_service when Start Local Blossom button is clicked", async () => {
    currentDiagnostics = mockDiagnosticsPartial;
    const onServiceToggled = vi.fn();
    render(<SovereigntyStatusPanel onServiceToggled={onServiceToggled} />);

    await waitFor(() => {
      expect(screen.getByText(/Start Local Blossom/i)).toBeInTheDocument();
    });

    const startBlossomBtn = screen.getByText(/Start Local Blossom/i);
    fireEvent.click(startBlossomBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("toggle_service", {
        name: "Blossom",
        action: "start",
      });
      expect(onServiceToggled).toHaveBeenCalled();
    });
  });

  it("adds a new public relay via inline input", async () => {
    currentDiagnostics = mockDiagnosticsPartial;
    render(<SovereigntyStatusPanel />);

    await waitFor(() => {
      expect(screen.getByText(/\+ Add Relay/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/\+ Add Relay/i));

    const input = screen.getByPlaceholderText("wss://relay.example.com");
    fireEvent.change(input, { target: { value: "wss://relay.snort.social" } });

    const addBtn = screen.getByRole("button", { name: "Add" });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("add_mesh_relay", {
        relayUrl: "wss://relay.snort.social",
      });
    });
  });

  it("opens backup modal on Export Backup click and triggers backup generation", async () => {
    currentDiagnostics = mockDiagnosticsPartial;
    render(<SovereigntyStatusPanel />);

    await waitFor(() => {
      expect(screen.getByText(/Export Backup/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Export Backup/i));

    expect(screen.getByText(/Export Sovereign Vault Backup/i)).toBeInTheDocument();

    const pwInputs = screen.getAllByPlaceholderText(/password/i);
    fireEvent.change(pwInputs[0], { target: { value: "TestSecret123!" } });
    fireEvent.change(pwInputs[1], { target: { value: "TestSecret123!" } });

    const submitBtn = screen.getByRole("button", { name: /Export Backup \(\.iyoubackup\)/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("create_vault_backup", {
        password: "TestSecret123!",
      });
      expect(mockInvoke).toHaveBeenCalledWith("record_backup_timestamp");
    });
  });
});
