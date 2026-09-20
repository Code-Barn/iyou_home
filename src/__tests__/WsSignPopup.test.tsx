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
import WsSignPopup, { isEligibleForGraceAutoSign } from "../components/WsSignPopup";
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

  describe("Lock Suppression and Session Grace Period Gate", () => {
    it("does not render modal when isAppLocked is true and stashes pending request", async () => {
      const { rerender } = render(<WsSignPopup isAppLocked={true} />);

      // Send signing request while locked
      await act(async () => {
        channelCallback?.(
          JSON.stringify({
            __type__: "sign",
            challenge: "auth-challenge-while-locked",
          }),
        );
      });

      // Modal must NOT be in DOM
      expect(screen.queryByText("Signature Request")).not.toBeInTheDocument();

      // Unlock enclave (isAppLocked becomes false, grace period = 0)
      await act(async () => {
        rerender(<WsSignPopup isAppLocked={false} authSessionValidUntil={0} />);
      });

      // Now the pending request is revealed cleanly
      await waitFor(() => {
        expect(screen.getByText("Signature Request")).toBeInTheDocument();
        expect(screen.getByText("auth-challenge-while-locked")).toBeInTheDocument();
      });
    });

    it("auto-signs standard kind: 1 note when session grace period is active", async () => {
      const futureSessionTime = Date.now() + 3600 * 1000;
      render(<WsSignPopup isAppLocked={false} authSessionValidUntil={futureSessionTime} />);

      const noteEvent = {
        kind: 1,
        content: "Hello micro-post without popup fatigue!",
        tags: [],
      };

      await act(async () => {
        channelCallback?.(
          JSON.stringify({
            __type__: "sign_event",
            event: noteEvent,
          }),
        );
      });

      // Does not block on modal DOM
      expect(screen.queryByText("Nostr Event Signing Request")).not.toBeInTheDocument();

      // Directly submits approval
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("submit_ws_event_response", {
          eventJson: JSON.stringify(noteEvent),
          approved: true,
          profileId: "burner_alpha",
        });
      });
    });

    it("auto-signs standard OIDC login challenge when session grace period is active", async () => {
      const futureSessionTime = Date.now() + 3600 * 1000;
      render(<WsSignPopup isAppLocked={false} authSessionValidUntil={futureSessionTime} />);

      await act(async () => {
        channelCallback?.(
          JSON.stringify({
            __type__: "sign",
            challenge: "https://idp.iyou.me/auth?challenge=oauth_state_12345",
          }),
        );
      });

      // Modal is bypassed
      expect(screen.queryByText("Signature Request")).not.toBeInTheDocument();

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("submit_ws_response", {
          id: "",
          challenge: "https://idp.iyou.me/auth?challenge=oauth_state_12345",
          approved: true,
          profileId: "burner_alpha",
        });
      });
    });

    it("ignores grace period and forces modal review for high-risk operations", async () => {
      const futureSessionTime = Date.now() + 3600 * 1000;
      render(<WsSignPopup isAppLocked={false} authSessionValidUntil={futureSessionTime} />);

      await act(async () => {
        channelCallback?.(
          JSON.stringify({
            __type__: "sign",
            challenge: "high-risk-reveal-master-seed-challenge",
          }),
        );
      });

      // High-risk must ignore grace timer and display modal!
      await waitFor(() => {
        expect(screen.getByText("Signature Request")).toBeInTheDocument();
        expect(screen.getByText("high-risk-reveal-master-seed-challenge")).toBeInTheDocument();
      });
    });

    it("does not auto-sign pending request upon unlock even when grace period is active, forcing manual review", async () => {
      const futureSessionTime = Date.now() + 3600 * 1000;
      const { rerender } = render(<WsSignPopup isAppLocked={true} authSessionValidUntil={0} />);

      const noteEvent = {
        kind: 1,
        content: "Queued note while locked",
        tags: [],
      };

      // Arrives while locked
      await act(async () => {
        channelCallback?.(
          JSON.stringify({
            __type__: "sign_event",
            event: noteEvent,
          }),
        );
      });

      expect(screen.queryByText("Nostr Event Signing Request")).not.toBeInTheDocument();

      // Unlock with active grace period recorded
      await act(async () => {
        rerender(<WsSignPopup isAppLocked={false} authSessionValidUntil={futureSessionTime} />);
      });

      // Must NOT auto-approve: modal must appear with Approve/Deny buttons!
      await waitFor(() => {
        expect(screen.getByText("Nostr Event Signing Request")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Approve & Sign/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Deny/i })).toBeInTheDocument();
      });
      expect(mockInvoke).not.toHaveBeenCalledWith("submit_ws_event_response", expect.anything());

      // User manually approves
      const approveBtn = screen.getByRole("button", { name: /Approve & Sign/i });
      await act(async () => {
        fireEvent.click(approveBtn);
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("submit_ws_event_response", {
          eventJson: JSON.stringify(noteEvent),
          approved: true,
          profileId: "burner_alpha",
        });
        expect(screen.queryByText("Nostr Event Signing Request")).not.toBeInTheDocument();
      });

      // Subsequent incoming request while unlocked with active grace period auto-signs normally
      mockInvoke.mockClear();
      const subsequentEvent = {
        kind: 1,
        content: "Subsequent note while unlocked",
        tags: [],
      };

      await act(async () => {
        channelCallback?.(
          JSON.stringify({
            __type__: "sign_event",
            event: subsequentEvent,
          }),
        );
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("submit_ws_event_response", {
          eventJson: JSON.stringify(subsequentEvent),
          approved: true,
          profileId: "burner_alpha",
        });
      });
      expect(screen.queryByText("Nostr Event Signing Request")).not.toBeInTheDocument();
    });
  });

  describe("isEligibleForGraceAutoSign Predicate Evaluation", () => {
    const publicProfile: Profile = {
      profile_id: "primary",
      profile_name: "Public Persona",
      derivation_index: 1,
      did: "did:key:z6MkPrimary11111111111111111111111111",
      level: 1,
      is_system_reserved: false,
    };

    const anchorProfile: Profile = {
      profile_id: "anchor",
      profile_name: "Anchor Persona",
      derivation_index: 0,
      did: "did:key:z6MkAnchor00000000000000000000000000",
      level: 0,
      is_system_reserved: true,
    };

    it("permits standard Nostr kind: 1 notes for public persona", () => {
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign_event", event: { kind: 1, content: "hello" } },
          publicProfile,
        ),
      ).toBe(true);
    });

    it("rejects requests flagged with wasQueued: true", () => {
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign_event", event: { kind: 1, content: "hello" }, wasQueued: true },
          publicProfile,
        ),
      ).toBe(false);
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign", challenge: "random-nonce-12345", wasQueued: true },
          publicProfile,
        ),
      ).toBe(false);
    });

    it("rejects non-kind-1 Nostr events (e.g. kind 0, 3, 1063)", () => {
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign_event", event: { kind: 0, content: "{}" } },
          publicProfile,
        ),
      ).toBe(false);
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign_event", event: { kind: 1063, content: "file" } },
          publicProfile,
        ),
      ).toBe(false);
    });

    it("permits standard OIDC challenges for public persona", () => {
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign", challenge: "random-nonce-12345" },
          publicProfile,
        ),
      ).toBe(true);
    });

    it("rejects high risk challenges mentioning seed, export, rotate", () => {
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign", challenge: "reveal master seed" },
          publicProfile,
        ),
      ).toBe(false);
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign", challenge: "export root seed" },
          publicProfile,
        ),
      ).toBe(false);
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign", challenge: "rotate keys" },
          publicProfile,
        ),
      ).toBe(false);
    });

    it("strictly rejects any signing request targeting Level 0 Anchor", () => {
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign_event", event: { kind: 1, content: "hello" } },
          anchorProfile,
        ),
      ).toBe(false);
      expect(
        isEligibleForGraceAutoSign(
          { type: "sign", challenge: "random-nonce-12345" },
          anchorProfile,
        ),
      ).toBe(false);
    });

    it("rejects credentials and credential presentations", () => {
      expect(
        isEligibleForGraceAutoSign(
          {
            type: "sign_credential",
            credential: {},
            holder_did: "did:key:123",
          },
          publicProfile,
        ),
      ).toBe(false);
      expect(
        isEligibleForGraceAutoSign(
          {
            type: "POLY_CREDENTIAL_REQUEST",
            required_credential_type: "Passport",
            challenge: "123",
          },
          publicProfile,
        ),
      ).toBe(false);
    });
  });
});
