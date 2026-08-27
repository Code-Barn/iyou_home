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

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
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
      default:
        return Promise.resolve();
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  Channel: vi.fn().mockImplementation(() => ({
    onmessage: null,
  })),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

describe("App", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("renders all main tabs", () => {
    render(<App />);
    // Tab buttons are inside .tabs container; status bar also has button text matching "Enclave"
    const tabs = document.querySelector(".tabs");
    expect(tabs?.textContent).toContain("Enclave");
    expect(tabs?.textContent).toContain("Credentials");
    expect(tabs?.textContent).toContain("Vault");
    expect(tabs?.textContent).toContain("Services");
    expect(tabs?.textContent).toContain("Governance");
  });

  it("defaults to Enclave tab on launch", () => {
    render(<App />);
    const tabs = document.querySelector(".tabs");
    const enclaveTab = tabs?.querySelector("button.active");
    expect(enclaveTab).toBeTruthy();
    expect(enclaveTab?.textContent).toContain("Enclave");
  });

  it("renders status bar with daemon indicators", () => {
    render(<App />);
    expect(screen.getByText("iyou_home")).toBeInTheDocument();
    expect(screen.getByText("SigBridge")).toBeInTheDocument();
    expect(screen.getByText("Nostr")).toBeInTheDocument();
    expect(screen.getByText("Blossom")).toBeInTheDocument();
  });

  it("navigates to Services tab and renders service list", async () => {
    render(<App />);

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
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Services/i }));
    });

    const startButtons = screen.getAllByRole("button", {
      name: /start/i,
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
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Services/i }));
    });

    const startButtons = screen.getAllByRole("button", {
      name: /start/i,
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
      expect(screen.getAllByRole("button", { name: /start/i }).length).toBe(3);
    });
  });

  it("renders Developer Mode toggle in footer", () => {
    render(<App />);
    expect(screen.getByText("Developer Mode")).toBeInTheDocument();
  });

  it("Developer Mode toggle shows Manual Signer tab", async () => {
    render(<App />);

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
    render(<App />);

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
    render(<App />);
    expect(screen.getByText("Sync")).toBeInTheDocument();
  });

  it("navigates to Vault tab, renders redundancy banner and handles session revocation", async () => {
    render(<App />);

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
    render(<App />);

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
});
