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
import InviteManager from "../components/invites/InviteManager";
import type { InviteCapabilityToken, IssuerStatus, InviteRecord } from "../lib/types";

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const { mockInvoke, defaultHandler } = vi.hoisted(() => {
  const MEMBER_STATUS: IssuerStatus = {
    did: "did:key:z6Mkprimary",
    role: "member",
    quota_used_last_30d: 1,
    quota_limit: 3,
    vetting: {
      account_age_days: 60,
      contact_count: 6,
      active_moderation_flags: 0,
      account_age_ok: true,
      contacts_ok: true,
      flags_ok: true,
      eligible: true,
    },
  };

  const LIVE_INVITE: InviteRecord = {
    nonce: "aa11bb22cc33dd44ee55ff6677889900",
    token_json: "{}",
    issuer_did: "did:key:z6Mkprimary",
    tier: "member",
    created_at: 1700000000,
    expires_at: 1710000000,
    child_did: null,
    uses_count: 0,
    max_uses: 1,
    status: "live",
  };

  const TOKEN: InviteCapabilityToken = {
    v: 1,
    issuer_did: "did:key:z6Mkprimary",
    satellite_id: "",
    nonce: "deadbeefdeadbeefdeadbeefdeadbeef",
    max_uses: 1,
    uses_count: 0,
    tier: "member",
    created_at: 1700000000,
    expires_at: 1702592000,
    scope: ["join"],
    signature: "4KzVk5QbCwzV67QVqZhTBDuuKeQwGW4N2YjK2od6zGtKjWy8Ry5WhZPqMR1ygkZbJD8kJqbzLZJAgASk3bK7x3Yu",
  };

  const handler: InvokeHandler = (cmd, _args) => {
    switch (cmd) {
      case "get_issuer_status":
        return Promise.resolve(MEMBER_STATUS);
      case "list_invites":
        return Promise.resolve([LIVE_INVITE]);
      case "create_invite_token":
        return Promise.resolve(TOKEN);
      case "render_invite_qr":
        return Promise.resolve("data:image/png;base64,iVBORw0KGgo=");
      case "revoke_invite":
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  };

  return { mockInvoke: vi.fn<InvokeHandler>(handler), defaultHandler: handler };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

describe("InviteManager (RFC-002)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(defaultHandler);
  });

  it("renders the role badge, quota counter and vetting chips", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") {
        return Promise.resolve({
          did: "did:key:z6Mkprimary",
          role: "member",
          quota_used_last_30d: 2,
          quota_limit: 3,
          vetting: {
            account_age_days: 60,
            contact_count: 6,
            active_moderation_flags: 0,
            account_age_ok: true,
            contacts_ok: true,
            flags_ok: true,
            eligible: true,
          },
        });
      }
      if (cmd === "list_invites") return Promise.resolve([]);
      return Promise.resolve();
    });

    render(<InviteManager />);

    await waitFor(() => {
      expect(screen.getByTestId("invite-role")).toHaveTextContent("Member");
    });
    expect(screen.getByTestId("invite-quota")).toHaveTextContent("2 / 3 used");
    expect(screen.getByTestId("vetting-chip-Account-60d")).toHaveTextContent("✓ Account 60d");
    expect(screen.getByTestId("vetting-chip-6-contacts")).toHaveTextContent("✓ 6 contacts");
    expect(screen.getByText(/No invites issued yet/)).toBeInTheDocument();
  });

  it("mints a token and shows the copyable JSON and QR code", async () => {
    render(<InviteManager />);

    // Open the modal.
    fireEvent.click(await screen.findByTestId("invite-issue-button"));
    expect(screen.getByTestId("invite-modal")).toBeInTheDocument();

    // Member issuers are locked to member tier.
    const tierSelect = screen.getByTestId("invite-tier-select");
    expect(tierSelect).toBeDisabled();

    // Configure max uses, expiry and a satellite binding.
    fireEvent.change(screen.getByTestId("invite-max-uses"), { target: { value: "2" } });
    fireEvent.change(screen.getByTestId("invite-valid-days"), { target: { value: "30" } });
    fireEvent.change(screen.getByTestId("invite-satellite"), {
      target: { value: "sat.iyou.me" },
    });
    fireEvent.click(screen.getByTestId("invite-scope-relay:read"));

    fireEvent.click(screen.getByTestId("invite-submit"));

    // Minted result: copyable JSON + QR image.
    const jsonArea = await screen.findByTestId("invite-token-json");
    expect((jsonArea as HTMLTextAreaElement).value).toContain(
      "deadbeefdeadbeefdeadbeefdeadbeef",
    );
    expect(screen.getByTestId("invite-qr-image")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");

    expect(mockInvoke).toHaveBeenCalledWith("create_invite_token", {
      tier: "member",
      maxUses: 2,
      validDays: 30,
      scope: ["join", "relay:read"],
      satelliteId: "sat.iyou.me",
    });
  });

  it("surfaces issuance errors from the policy gate", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "create_invite_token") {
        return Promise.reject("Rolling 30-day issuance quota exhausted (3 of 3 used)");
      }
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));
    fireEvent.click(screen.getByTestId("invite-submit"));

    const err = await screen.findByTestId("invite-mint-error");
    expect(err).toHaveTextContent("quota exhausted");
  });

  it("revokes a live invite and refreshes the ledger", async () => {
    render(<InviteManager />);

    // Set the post-revocation ledger BEFORE revoking so the refresh inside
    // the revoke handler observes the new state.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_invites") {
        return Promise.resolve([
          {
            nonce: "aa11bb22cc33dd44ee55ff6677889900",
            token_json: "{}",
            issuer_did: "did:key:z6Mkprimary",
            tier: "member",
            created_at: 1700000000,
            expires_at: 1710000000,
            child_did: null,
            uses_count: 0,
            max_uses: 1,
            status: "revoked",
          },
        ]);
      }
      return defaultHandler(cmd);
    });

    const row = await screen.findByTestId("invite-row-aa11bb22cc33dd44ee55ff6677889900");
    expect(row).toHaveTextContent("live");

    fireEvent.click(screen.getByTestId("invite-revoke-aa11bb22cc33dd44ee55ff6677889900"));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("revoke_invite", {
        nonce: "aa11bb22cc33dd44ee55ff6677889900",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("invite-status-aa11bb22cc33dd44ee55ff6677889900")).toHaveTextContent("revoked");
    });
  });

  it("renders every status pill and admin sees unlimited quota", async () => {
    const records: InviteRecord[] = [
      {
        nonce: "00000000000000000000000000000001",
        token_json: "{}",
        issuer_did: "did:key:z6Mkprimary",
        tier: "member",
        created_at: 1700000000,
        expires_at: 1710000000,
        child_did: null,
        uses_count: 0,
        max_uses: 1,
        status: "live",
      },
      {
        nonce: "00000000000000000000000000000002",
        token_json: "{}",
        issuer_did: "did:key:z6Mkprimary",
        tier: "member",
        created_at: 1700000000,
        expires_at: 1710000000,
        child_did: "did:key:z6Mkchild",
        uses_count: 1,
        max_uses: 1,
        status: "used",
      },
      {
        nonce: "00000000000000000000000000000003",
        token_json: "{}",
        issuer_did: "did:key:z6Mkprimary",
        tier: "admin",
        created_at: 1700000000,
        expires_at: 1710000000,
        child_did: null,
        uses_count: 0,
        max_uses: 4,
        status: "revoked",
      },
      {
        nonce: "00000000000000000000000000000004",
        token_json: "{}",
        issuer_did: "did:key:z6Mkprimary",
        tier: "guest",
        created_at: 1700000000,
        expires_at: 1700000100,
        child_did: null,
        uses_count: 0,
        max_uses: 1,
        status: "expired",
      },
    ];

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") {
        return Promise.resolve({
          did: "did:key:z6Mkprimary",
          role: "admin",
          quota_used_last_30d: 7,
          quota_limit: 0,
          vetting: {
            account_age_days: 60,
            contact_count: 6,
            active_moderation_flags: 0,
            account_age_ok: true,
            contacts_ok: true,
            flags_ok: true,
            eligible: true,
          },
        });
      }
      if (cmd === "list_invites") return Promise.resolve(records);
      return Promise.resolve();
    });

    render(<InviteManager />);

    await waitFor(() => {
      expect(screen.getByTestId("invite-role")).toHaveTextContent("Admin");
    });
    expect(screen.getByTestId("invite-quota")).toHaveTextContent("Unlimited");
    expect(screen.getByTestId("invite-status-00000000000000000000000000000001")).toHaveTextContent("live");
    expect(screen.getByTestId("invite-status-00000000000000000000000000000002")).toHaveTextContent("used");
    expect(screen.getByTestId("invite-status-00000000000000000000000000000003")).toHaveTextContent("revoked");
    expect(screen.getByTestId("invite-status-00000000000000000000000000000004")).toHaveTextContent("expired");
  });

  it("lets admins choose any tier and skips the quota", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") {
        return Promise.resolve({
          did: "did:key:z6Mkprimary",
          role: "admin",
          quota_used_last_30d: 7,
          quota_limit: 0,
          vetting: {
            account_age_days: 60,
            contact_count: 6,
            active_moderation_flags: 0,
            account_age_ok: true,
            contacts_ok: true,
            flags_ok: true,
            eligible: true,
          },
        });
      }
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));

    const tierSelect = screen.getByTestId("invite-tier-select");
    expect(tierSelect).not.toBeDisabled();
    const options = Array.from(tierSelect.querySelectorAll("option")).map((o) => o.value);
    expect(options).toEqual(["member", "admin", "guest"]);

    fireEvent.change(tierSelect, { target: { value: "guest" } });
    fireEvent.click(screen.getByTestId("invite-submit"));

    await screen.findByTestId("invite-token-json");
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_invite_token",
      expect.objectContaining({ tier: "guest" }),
    );
  });
});