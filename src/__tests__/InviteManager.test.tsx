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

const { mockInvoke, defaultHandler, TOKEN } = vi.hoisted(() => {
  const MEMBER_STATUS: IssuerStatus = {
    did: "did:key:z6Mkprimary",
    role: "member",
    quota_used_last_30d: 1,
    quota_limit: 3,
    issuance_quota_limit: 3,
    max_uses_limit: 4,
    vetting: {
      account_age_days: 60,
      contact_count: 6,
      min_contacts_required: 5,
      contacts_remaining: -1,
      active_moderation_flags: 0,
      account_age_ok: true,
      contacts_ok: true,
      flags_ok: true,
      eligible: true,
      is_genesis: false,
      bypass_reason: null,
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
      case "list_contacts":
        return Promise.resolve([]);
      case "set_vetting_threshold":
        return Promise.resolve(5);
      case "create_invite_token":
        return Promise.resolve(TOKEN);
      case "render_invite_qr":
        return Promise.resolve({
          link: "https://iyou.me/airlock/?invite=eyJ2IjoxfQ",
          qr_data_url: "data:image/png;base64,iVBORw0KGgo=",
        });
      case "revoke_invite":
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  };

  return { mockInvoke: vi.fn<InvokeHandler>(handler), defaultHandler: handler, TOKEN };
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
          issuance_quota_limit: 3,
          max_uses_limit: 4,
          vetting: {
            account_age_days: 60,
            contact_count: 6,
            min_contacts_required: 5,
            contacts_remaining: -1,
            active_moderation_flags: 0,
            account_age_ok: true,
            contacts_ok: true,
            flags_ok: true,
            eligible: true,
            is_genesis: false,
            bypass_reason: null,
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
    expect(screen.getByTestId("vetting-chip-6-5-contacts")).toHaveTextContent("✓ 6/5 contacts");
    expect(screen.getByTestId("vetting-chip-0-mod-flags")).toHaveTextContent("✓ 0 mod flags");
    expect(screen.getByText(/No invites issued yet/)).toBeInTheDocument();
  });

  it("mints a token and shows the copyable JSON, invite link and QR code", async () => {
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

    // Minted result: copyable JSON + invite link + QR image.
    const jsonArea = await screen.findByTestId("invite-token-json");
    expect((jsonArea as HTMLTextAreaElement).value).toContain(
      "deadbeefdeadbeefdeadbeefdeadbeef",
    );
    expect(screen.getByTestId("invite-qr-image")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");

    // The enclave builds the link from the same token JSON; the modal forwards
    // that exact string rather than encoding it in the browser.
    expect(mockInvoke).toHaveBeenCalledWith("render_invite_qr", {
      tokenJson: JSON.stringify(TOKEN),
    });
    expect(screen.getByTestId("invite-copy-link")).toHaveTextContent("Copy Invite Link");

    expect(mockInvoke).toHaveBeenCalledWith("create_invite_token", {
      tier: "member",
      maxUses: 2,
      validDays: 30,
      scope: ["join", "relay:read"],
      satelliteId: "sat.iyou.me",
    });
  });

  it("copies the airlock invite link to the clipboard", async () => {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));
    fireEvent.click(screen.getByTestId("invite-submit"));

    const copyLink = await screen.findByTestId("invite-copy-link");
    fireEvent.click(copyLink);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://iyou.me/airlock/?invite=eyJ2IjoxfQ");
    });
    expect(await screen.findByTestId("invite-copy-link")).toHaveTextContent("Link Copied");
  });

  it("clamps max_uses to 4 for an ordinary member", async () => {
    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));

    const input = screen.getByTestId("invite-max-uses") as HTMLInputElement;
    expect(input).toHaveAttribute("max", "4");
    expect(screen.getByText("Max uses (1–4)")).toBeInTheDocument();

    // A community-scale request is clamped down to the ordinary-peer ceiling.
    fireEvent.change(input, { target: { value: "50" } });
    expect(input).toHaveValue(4);

    fireEvent.click(screen.getByTestId("invite-submit"));
    await screen.findByTestId("invite-token-json");
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_invite_token",
      expect.objectContaining({ maxUses: 4 }),
    );
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
          issuance_quota_limit: null,
          max_uses_limit: 100,
          vetting: {
            account_age_days: 60,
            contact_count: 6,
            min_contacts_required: 5,
            contacts_remaining: -1,
            active_moderation_flags: 0,
            account_age_ok: true,
            contacts_ok: true,
            flags_ok: true,
            eligible: true,
            is_genesis: false,
            bypass_reason: null,
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
          issuance_quota_limit: null,
          max_uses_limit: 100,
          vetting: {
            account_age_days: 60,
            contact_count: 6,
            min_contacts_required: 5,
            contacts_remaining: -1,
            active_moderation_flags: 0,
            account_age_ok: true,
            contacts_ok: true,
            flags_ok: true,
            eligible: true,
            is_genesis: false,
            bypass_reason: null,
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
/** Root/operator standing: empty contact book, fresh account, Genesis flag set. */
function genesisStatus(vettingOverrides: Record<string, unknown> = {}): IssuerStatus {
  return {
    did: "did:key:z6Mkprimary",
    role: "member",
    quota_used_last_30d: 0,
    quota_limit: 0,
    issuance_quota_limit: null,
    max_uses_limit: 100,
    vetting: {
      account_age_days: 0,
      contact_count: 0,
      min_contacts_required: 5,
      contacts_remaining: 5,
      active_moderation_flags: 0,
      account_age_ok: false,
      contacts_ok: false,
      flags_ok: true,
      eligible: true,
      is_genesis: true,
      bypass_reason:
        "Operator bootstrap mode: mutual vetting bypassed (Genesis / Operator identity, 0 contact(s) — threshold 5 not applied)",
      ...vettingOverrides,
    },
  };
}

describe("InviteManager — Genesis / Operator bypass", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(defaultHandler);
    // Vitest runs with `import.meta.env.DEV === true`; pin it off so these
    // cases assert the Genesis logic rather than the dev affordance.
    vi.stubEnv("DEV", false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mints the bootstrap invite with 0 contacts where an ordinary member cannot", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisStatus());
      if (cmd === "list_contacts") return Promise.resolve([]);
      if (cmd === "list_invites") return Promise.resolve([]);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);

    // Tier reads "Genesis / Operator", not the raw registry role.
    await waitFor(() => {
      expect(screen.getByTestId("invite-role")).toHaveTextContent("Genesis / Operator");
    });

    // The bypass notice carries the exact required wording.
    expect(screen.getByTestId("invite-bypass-notice")).toHaveTextContent(
      "Operator bootstrap mode: mutual vetting bypassed",
    );

    fireEvent.click(screen.getByTestId("invite-issue-button"));
    expect(screen.getByTestId("invite-modal")).toBeInTheDocument();
    expect(screen.getByTestId("invite-modal-bypass-notice")).toHaveTextContent(
      "Operator bootstrap mode: mutual vetting bypassed",
    );

    // Mint & Sign is ENABLED despite 0 contacts, and the mint round-trips.
    const submit = screen.getByTestId("invite-submit");
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveTextContent("Mint & Sign (bypassed)");
    expect(screen.queryByTestId("invite-blocked-reason")).not.toBeInTheDocument();

    fireEvent.click(submit);
    await screen.findByTestId("invite-token-json");
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_invite_token",
      expect.objectContaining({ tier: "member" }),
    );
  });

  it("shows the honest 0-contact counter while waiving the threshold", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisStatus());
      if (cmd === "list_contacts") return Promise.resolve([]);
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));

    expect(screen.getByTestId("invite-threshold")).toHaveValue(5);
    expect(screen.getByTestId("invite-threshold-label")).toHaveTextContent(
      "mutual contacts (have 0)",
    );
    expect(screen.getByTestId("invite-threshold-label")).toHaveTextContent(
      "Not applied to you: Genesis / Operator bypass",
    );
  });

  it("persists a lowered threshold through set_vetting_threshold", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisStatus());
      if (cmd === "list_contacts") return Promise.resolve([]);
      if (cmd === "set_vetting_threshold") return Promise.resolve(args?.minContacts);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));

    fireEvent.change(screen.getByTestId("invite-threshold"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("invite-threshold-save"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("set_vetting_threshold", {
        minContacts: 2,
      });
    });
    await screen.findByTestId("invite-threshold-saved");
  });

  it("keeps Mint disabled and explains the block for an ordinary member", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") {
        return Promise.resolve(
          genesisStatus({
            is_genesis: false,
            account_age_days: 90,
            account_age_ok: true,
            eligible: false,
            bypass_reason: null,
          }),
        );
      }
      if (cmd === "list_contacts") return Promise.resolve([]);
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-role")).toHaveTextContent("Member");
    });
    // No bypass notice for an ordinary peer.
    expect(screen.queryByTestId("invite-bypass-notice")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("invite-issue-button"));

    expect(screen.getByTestId("invite-blocked-reason")).toHaveTextContent(
      "Member vetting: need >= 5 mutual contacts (have 0).",
    );
    expect(screen.getByTestId("invite-submit")).toBeDisabled();
  });

  it("raises the max_uses ceiling to 100 for a community-scale code", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisStatus());
      if (cmd === "list_contacts") return Promise.resolve([]);
      if (cmd === "list_invites") return Promise.resolve([]);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));

    const input = screen.getByTestId("invite-max-uses") as HTMLInputElement;
    expect(input).toHaveAttribute("max", "100");
    expect(screen.getByText("Max uses (1–100)")).toBeInTheDocument();
    expect(screen.getByTestId("invite-max-uses-hint")).toHaveTextContent(
      "Community-scale codes enabled for Genesis / Operator",
    );

    // A mid-range community code is submitted as-is, not clamped.
    fireEvent.change(input, { target: { value: "50" } });
    expect(input).toHaveValue(50);

    fireEvent.click(screen.getByTestId("invite-submit"));
    await screen.findByTestId("invite-token-json");
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_invite_token",
      expect.objectContaining({ maxUses: 50 }),
    );

    // The 100 ceiling still holds.
    fireEvent.click(screen.getByTestId("invite-issue-button"));
    fireEvent.change(screen.getByTestId("invite-max-uses"), { target: { value: "100" } });
    expect(screen.getByTestId("invite-max-uses")).toHaveValue(100);
  });

  it("blocks a flagged Genesis issuer — the bypass never waives moderation flags", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") {
        return Promise.resolve(
          genesisStatus({ active_moderation_flags: 2, flags_ok: false, eligible: false }),
        );
      }
      if (cmd === "list_contacts") return Promise.resolve([]);
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));

    expect(screen.getByTestId("invite-blocked-reason")).toHaveTextContent(
      "2 active moderation flag(s)",
    );
    expect(screen.getByTestId("invite-submit")).toBeDisabled();
  });
});

describe("InviteManager — rolling quota waiver and refund", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(defaultHandler);
    // Pin the dev affordance off so these cases assert the Genesis quota
    // logic rather than the `import.meta.env.DEV` waiver.
    vi.stubEnv("DEV", false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Genesis standing with a non-zero rolling-window count. */
  function genesisWithUsage(used: number): IssuerStatus {
    return { ...genesisStatus(), quota_used_last_30d: used };
  }

  it("shows an unlimited quota pill instead of 3 / 3 for Genesis / Operator", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisWithUsage(7));
      if (cmd === "list_contacts") return Promise.resolve([]);
      if (cmd === "list_invites") return Promise.resolve([]);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-role")).toHaveTextContent("Genesis / Operator");
    });

    // Past the old 3-token ceiling and still uncapped.
    const pill = screen.getByTestId("invite-quota");
    expect(pill).toHaveTextContent("7 issued (Unlimited)");
    expect(pill).not.toHaveTextContent("/ 3 used");
  });

  it("renders no exhaustion banner and keeps Mint & Sign enabled past the old cap", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisWithUsage(12));
      if (cmd === "list_contacts") return Promise.resolve([]);
      if (cmd === "list_invites") return Promise.resolve([]);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-quota")).toHaveTextContent("12 issued (Unlimited)");
    });

    fireEvent.click(screen.getByTestId("invite-issue-button"));

    // No red "Rolling 30-day issuance quota exhausted" banner.
    expect(screen.queryByTestId("invite-quota-exhausted")).not.toBeInTheDocument();
    expect(screen.queryByText(/quota exhausted/i)).not.toBeInTheDocument();

    // A positive note replaces it, naming the identity and the running count.
    expect(screen.getByTestId("invite-quota-waived")).toHaveTextContent(
      "Genesis / Operator — no 30-day issuance quota limit. 12 issued",
    );

    const submit = screen.getByTestId("invite-submit");
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveTextContent("Mint & Sign (bypassed)");

    // The 4th-and-beyond mint actually reaches the enclave.
    fireEvent.click(submit);
    await screen.findByTestId("invite-token-json");
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_invite_token",
      expect.objectContaining({ tier: "member" }),
    );
  });

  it("treats Genesis as uncapped even when a legacy backend still reports quota_limit: 3", async () => {
    // A pre-waiver enclave omits `issuance_quota_limit` and still reports the
    // stale numeric 3. The UI must mirror the new policy, not the stale field.
    const stale = { ...genesisWithUsage(3), issuance_quota_limit: undefined as never };
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") return Promise.resolve(stale);
      if (cmd === "list_contacts") return Promise.resolve([]);
      if (cmd === "list_invites") return Promise.resolve([]);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-quota")).toHaveTextContent("3 issued (Unlimited)");
    });

    fireEvent.click(screen.getByTestId("invite-issue-button"));
    expect(screen.queryByTestId("invite-quota-exhausted")).not.toBeInTheDocument();
    expect(screen.getByTestId("invite-submit")).not.toBeDisabled();
  });

  it("still blocks and banners a capped member whose quota is exhausted", async () => {
    // A fully vetted ordinary member, capped at 3, with the window spent.
    const capped: IssuerStatus = {
      ...genesisStatus({
        is_genesis: false,
        account_age_days: 90,
        account_age_ok: true,
        contacts_ok: true,
        contact_count: 9,
        eligible: true,
        bypass_reason: null,
      }),
      role: "member",
      quota_used_last_30d: 3,
      quota_limit: 3,
      issuance_quota_limit: 3,
      max_uses_limit: 4,
    };

    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") return Promise.resolve(capped);
      if (cmd === "list_contacts") return Promise.resolve([]);
      if (cmd === "list_invites") return Promise.resolve([]);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-quota")).toHaveTextContent("3 / 3 used");
    });

    fireEvent.click(screen.getByTestId("invite-issue-button"));

    // The banner names the refund path, and the button is disabled.
    const banner = screen.getByTestId("invite-quota-exhausted");
    expect(banner).toHaveTextContent("Rolling 30-day issuance quota exhausted (3 of 3 used)");
    expect(banner).toHaveTextContent("Revoke an unused invite to refund a slot");
    expect(screen.getByTestId("invite-submit")).toBeDisabled();
    // No waived note for a capped issuer.
    expect(screen.queryByTestId("invite-quota-waived")).not.toBeInTheDocument();
  });

  it("honours a raised enclave ceiling rather than assuming 3", async () => {
    const raised: IssuerStatus = {
      ...genesisStatus({ is_genesis: false, account_age_days: 90, account_age_ok: true, contacts_ok: true, contact_count: 9, eligible: true, bypass_reason: null }),
      quota_used_last_30d: 5,
      quota_limit: 10,
      issuance_quota_limit: 10,
      max_uses_limit: 4,
    };
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") return Promise.resolve(raised);
      if (cmd === "list_contacts") return Promise.resolve([]);
      if (cmd === "list_invites") return Promise.resolve([]);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-quota")).toHaveTextContent("5 / 10 used");
    });

    fireEvent.click(screen.getByTestId("invite-issue-button"));
    expect(screen.queryByTestId("invite-quota-exhausted")).not.toBeInTheDocument();
    expect(screen.getByTestId("invite-submit")).not.toBeDisabled();
  });
});

describe("InviteManager — dev fallback bypass", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(defaultHandler);
  });

  it("enables minting in a dev build and says so explicitly", async () => {
    // `import.meta.env.DEV` is true under vitest, which is exactly the
    // dev-build affordance the fallback is meant to cover.
    expect(import.meta.env.DEV).toBe(true);

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") {
        // Not Genesis, not Admin, 0 contacts: normally blocked.
        return Promise.resolve(genesisStatus({ is_genesis: false, eligible: false, bypass_reason: null }));
      }
      if (cmd === "list_contacts") return Promise.resolve([]);
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    await waitFor(() => {
      expect(screen.getByTestId("invite-bypass-notice")).toHaveTextContent(
        "Operator bootstrap mode: mutual vetting bypassed",
      );
    });
    expect(screen.getByTestId("invite-bypass-notice")).toHaveTextContent("frontend dev build");

    fireEvent.click(screen.getByTestId("invite-issue-button"));
    expect(screen.getByTestId("invite-submit")).not.toBeDisabled();
  });
});
