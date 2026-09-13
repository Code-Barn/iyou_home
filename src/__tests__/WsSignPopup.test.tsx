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
import WsSignPopup from "../components/WsSignPopup";
import type { Profile } from "../lib/types";

let channelCallback: ((data: string) => void) | null = null;

const mockProfiles: Profile[] = [
  {
    profile_id: "anchor",
    profile_name: "Anchor Identity",
    derivation_index: 0,
    did: "did:key:z6MkAnchor00000000000000000000000000",
    level: 0,
    is_system_reserved: true,
  },
  {
    profile_id: "primary",
    profile_name: "Public Persona",
    derivation_index: 1,
    did: "did:key:z6MkPrimary11111111111111111111111111",
    level: 1,
    is_system_reserved: false,
  },
  {
    profile_id: "burner_alpha",
    profile_name: "Burner Alpha",
    derivation_index: 2,
    did: "did:key:z6MkBurner22222222222222222222222222",
    level: 2,
    is_system_reserved: false,
  },
];

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "register_challenge_pipe": {
        const ch = (args as any)?.channel;
        if (ch) {
          channelCallback = ch.onmessage;
        }
        return Promise.resolve();
      }
      case "list_profiles":
        return Promise.resolve(mockProfiles);
      case "get_active_did":
        return Promise.resolve("did:key:z6MkBurner22222222222222222222222222"); // Burner Alpha is active
      case "submit_ws_response":
      case "submit_ws_event_response":
      case "submit_ws_credential_response":
      case "submit_ws_credential_presentation":
        return Promise.resolve();
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

describe("WsSignPopup - Persona Selection in Signing Modal", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    channelCallback = null;
  });

  it("excludes Level 0 Anchor and defaults to currently active profile", async () => {
    await act(async () => {
      render(<WsSignPopup />);
    });

    // Send a sign request via WebSocket channel
    await act(async () => {
      channelCallback?.(
        JSON.stringify({
          __type__: "sign",
          challenge: "mock-auth-challenge-xyz",
        }),
      );
    });

    // Modal should be visible
    expect(screen.getByText("Signature Request")).toBeInTheDocument();
    expect(screen.getByText("mock-auth-challenge-xyz")).toBeInTheDocument();

    // Dropdown selector should exist
    const select = screen.getByLabelText(/Signing Persona/i) as HTMLSelectElement;
    expect(select).toBeInTheDocument();

    // Level 0 Anchor identity must NOT be present in the selector
    expect(screen.queryByText(/Anchor Identity/i)).not.toBeInTheDocument();

    // Level 1 and Level 2 options must be present
    expect(screen.getByRole("option", { name: /Public Persona/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Burner Alpha/i })).toBeInTheDocument();

    // Default must be the currently active profile (burner_alpha)
    expect(select.value).toBe("burner_alpha");

    // Profile name and truncated DID should be displayed above payload preview
    expect(screen.getByText("Burner Alpha")).toBeInTheDocument();
    expect(screen.getByText(/did:key:z6MkBurner/i)).toBeInTheDocument();
  });

  it("allows switching to Level 1 (Public Persona) before clicking Approve & Sign", async () => {
    await act(async () => {
      render(<WsSignPopup />);
    });

    await act(async () => {
      channelCallback?.(
        JSON.stringify({
          __type__: "sign",
          challenge: "challenge-to-switch-identity",
        }),
      );
    });

    const select = screen.getByLabelText(/Signing Persona/i) as HTMLSelectElement;
    expect(select.value).toBe("burner_alpha");

    // Switch to Level 1 (Public Persona)
    await act(async () => {
      fireEvent.change(select, { target: { value: "primary" } });
    });

    expect(select.value).toBe("primary");
    // Displayed name and DID update to Public Persona
    expect(screen.getByText("Public Persona")).toBeInTheDocument();
    expect(screen.getByText(/did:key:z6MkPrimary/i)).toBeInTheDocument();

    // Click Approve & Sign
    const approveBtn = screen.getByRole("button", { name: /Approve & Sign/i });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("submit_ws_response", {
        id: "",
        challenge: "challenge-to-switch-identity",
        approved: true,
        profileId: "primary",
      });
    });
  });

  it("signs a Nostr event with the selected profile", async () => {
    await act(async () => {
      render(<WsSignPopup />);
    });

    const mockEvent = {
      kind: 1,
      content: "Broadcasting event from enclave",
      tags: [],
    };

    await act(async () => {
      channelCallback?.(
        JSON.stringify({
          __type__: "sign_event",
          event: mockEvent,
        }),
      );
    });

    expect(screen.getByText("Nostr Event Signing Request")).toBeInTheDocument();

    const select = screen.getByLabelText(/Signing Persona/i) as HTMLSelectElement;
    // Switch to Level 1
    await act(async () => {
      fireEvent.change(select, { target: { value: "primary" } });
    });

    const approveBtn = screen.getByRole("button", { name: /Approve & Sign/i });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("submit_ws_event_response", {
        eventJson: JSON.stringify(mockEvent),
        approved: true,
        profileId: "primary",
      });
    });
  });

  it("handles Deny action properly", async () => {
    await act(async () => {
      render(<WsSignPopup />);
    });

    await act(async () => {
      channelCallback?.(
        JSON.stringify({
          __type__: "sign",
          challenge: "challenge-to-deny",
        }),
      );
    });

    const denyBtn = screen.getByRole("button", { name: /Deny/i });
    await act(async () => {
      fireEvent.click(denyBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("submit_ws_response", {
        id: "",
        challenge: "challenge-to-deny",
        approved: false,
        profileId: "burner_alpha",
      });
    });
  });
});
