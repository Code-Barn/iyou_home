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
import InviteManager, { INVITE_QR_MODAL_HELPER_COPY } from "../components/invites/InviteManager";
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
    expect(screen.getByTestId("invite-standing")).toHaveTextContent("✓ Fully Vetted (60d · 6 mutuals · 0 flags)");
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
    expect(screen.getByTestId("invite-qr-hint")).toHaveTextContent(INVITE_QR_MODAL_HELPER_COPY);

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

  it("renders Copy Link and QR buttons for live and claimed table rows, but not exhausted or revoked", async () => {
    const activeLiveInvite: InviteRecord = {
      nonce: "nonce-live-1",
      token_json: JSON.stringify({ nonce: "nonce-live-1", scope: ["join"] }),
      token_base64: "bGl2ZS10b2tlbg",
      issuer_did: "did:key:z6Mkprimary",
      tier: "member",
      created_at: 1700000000,
      expires_at: 1710000000,
      child_did: null,
      uses_count: 0,
      max_uses: 2,
      status: "live",
    };
    const claimedInvite: InviteRecord = {
      nonce: "nonce-claimed-2",
      token_json: JSON.stringify({ nonce: "nonce-claimed-2", scope: ["join"] }),
      token_base64: "Y2xhaW1lZC10b2tlbg",
      issuer_did: "did:key:z6Mkprimary",
      tier: "member",
      created_at: 1700000000,
      expires_at: 1710000000,
      child_did: "did:key:z6Mkchild",
      uses_count: 1,
      max_uses: 2,
      status: "live",
    };
    const exhaustedInvite: InviteRecord = {
      nonce: "nonce-exhausted-3",
      token_json: JSON.stringify({ nonce: "nonce-exhausted-3" }),
      token_base64: "ZXhoYXVzdGVk",
      issuer_did: "did:key:z6Mkprimary",
      tier: "member",
      created_at: 1700000000,
      expires_at: 1710000000,
      child_did: "did:key:z6Mkchild2",
      uses_count: 2,
      max_uses: 2,
      status: "used",
    };
    const revokedInvite: InviteRecord = {
      nonce: "nonce-revoked-4",
      token_json: JSON.stringify({ nonce: "nonce-revoked-4" }),
      token_base64: "cmV2b2tlZA",
      issuer_did: "did:key:z6Mkprimary",
      tier: "member",
      created_at: 1700000000,
      expires_at: 1710000000,
      child_did: null,
      uses_count: 0,
      max_uses: 1,
      status: "revoked",
    };

    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_invites") {
        return Promise.resolve([activeLiveInvite, claimedInvite, exhaustedInvite, revokedInvite]);
      }
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);

    // Live invite row has Copy Link, QR, and Revoke
    await waitFor(() => {
      expect(screen.getByTestId("invite-copy-link-nonce-live-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("invite-qr-nonce-live-1")).toBeInTheDocument();
    expect(screen.getByTestId("invite-revoke-nonce-live-1")).toBeInTheDocument();

    // Claimed invite row has Copy Link, QR, and Revoke
    expect(screen.getByTestId("invite-copy-link-nonce-claimed-2")).toBeInTheDocument();
    expect(screen.getByTestId("invite-qr-nonce-claimed-2")).toBeInTheDocument();
    expect(screen.getByTestId("invite-revoke-nonce-claimed-2")).toBeInTheDocument();

    // Exhausted invite row does NOT have Copy Link or QR, but has Revoke
    expect(screen.queryByTestId("invite-copy-link-nonce-exhausted-3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-qr-nonce-exhausted-3")).not.toBeInTheDocument();
    expect(screen.getByTestId("invite-revoke-nonce-exhausted-3")).toBeInTheDocument();

    // Revoked invite row has NONE of the actions
    expect(screen.queryByTestId("invite-copy-link-nonce-revoked-4")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-qr-nonce-revoked-4")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-revoke-nonce-revoked-4")).not.toBeInTheDocument();
  });

  it("copies airlock link to clipboard from table row Copy Link button", async () => {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    const activeInvite: InviteRecord = {
      nonce: "nonce-copy-test",
      token_json: JSON.stringify({ nonce: "nonce-copy-test" }),
      token_base64: "dGVzdC1iYXNlNjQtdG9rZW4",
      issuer_did: "did:key:z6Mkprimary",
      tier: "member",
      created_at: 1700000000,
      expires_at: 1710000000,
      child_did: null,
      uses_count: 0,
      max_uses: 1,
      status: "live",
    };

    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_invites") return Promise.resolve([activeInvite]);
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);

    const copyBtn = await screen.findByTestId("invite-copy-link-nonce-copy-test");
    expect(copyBtn).toHaveTextContent("Copy Link");

    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://iyou.me/airlock/?invite=dGVzdC1iYXNlNjQtdG9rZW4");
    });
    expect(copyBtn).toHaveTextContent("Copied!");
  });

  it("opens QR modal from table row QR button and shows helper microcopy", async () => {
    const activeInvite: InviteRecord = {
      nonce: "nonce-qr-test",
      token_json: JSON.stringify({ nonce: "nonce-qr-test", tier: "member" }),
      token_base64: "dGVzdC1xci1iYXNlNjQ",
      issuer_did: "did:key:z6Mkprimary",
      tier: "member",
      created_at: 1700000000,
      expires_at: 1710000000,
      child_did: null,
      uses_count: 0,
      max_uses: 1,
      status: "live",
    };

    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_invites") return Promise.resolve([activeInvite]);
      if (cmd === "render_invite_qr") {
        return Promise.resolve({
          link: "https://iyou.me/airlock/?invite=dGVzdC1xci1iYXNlNjQ",
          qr_data_url: "data:image/png;base64,QRTEST==",
        });
      }
      return defaultHandler(cmd, args);
    });

    render(<InviteManager />);

    const qrBtn = await screen.findByTestId("invite-qr-nonce-qr-test");
    fireEvent.click(qrBtn);

    expect(await screen.findByTestId("invite-modal")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("render_invite_qr", {
      tokenJson: activeInvite.token_json,
    });
    expect(screen.getByTestId("invite-qr-image")).toHaveAttribute(
      "src",
      "data:image/png;base64,QRTEST==",
    );
    expect(screen.getByTestId("invite-qr-hint")).toHaveTextContent(
      "You can re-open this QR code or copy the airlock link at any time from your Invites table.",
    );
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
    expect(row).toHaveTextContent("Live");

    fireEvent.click(screen.getByTestId("invite-revoke-aa11bb22cc33dd44ee55ff6677889900"));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("revoke_invite", {
        nonce: "aa11bb22cc33dd44ee55ff6677889900",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("invite-status-aa11bb22cc33dd44ee55ff6677889900")).toHaveTextContent("Revoked");
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
      {
        nonce: "00000000000000000000000000000005",
        token_json: "{}",
        issuer_did: "did:key:z6Mkprimary",
        tier: "member",
        created_at: 1700000000,
        expires_at: 1710000000,
        child_did: "did:key:z6Mkchild2",
        uses_count: 1,
        max_uses: 4,
        status: "used",
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
    // Status pills are title-cased product copy, not raw enum values.
    expect(screen.getByTestId("invite-status-00000000000000000000000000000001")).toHaveTextContent("Live");
    expect(screen.getByTestId("invite-status-00000000000000000000000000000002")).toHaveTextContent("Exhausted");
    expect(screen.getByTestId("invite-status-00000000000000000000000000000003")).toHaveTextContent("Revoked");
    expect(screen.getByTestId("invite-status-00000000000000000000000000000004")).toHaveTextContent("Expired");
    // Partial-use token (1 of 4 uses) displays "Claimed" rather than "Exhausted"
    expect(screen.getByTestId("invite-status-00000000000000000000000000000005")).toHaveTextContent("Claimed");
  });

  it("renders 'Claimed' for tokens with partial redemptions (e.g. 1 of 4 uses) instead of 'Exhausted'", async () => {
    const partialRecord: InviteRecord = {
      nonce: "11111111111111111111111111111111",
      token_json: "{}",
      issuer_did: "did:key:z6Mkprimary",
      tier: "member",
      created_at: 1700000000,
      expires_at: 1710000000,
      child_did: "did:key:z6Mkrecipient",
      uses_count: 1,
      max_uses: 4,
      status: "used",
    };

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "list_invites") return Promise.resolve([partialRecord]);
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    const statusPill = await screen.findByTestId("invite-status-11111111111111111111111111111111");
    expect(statusPill).toHaveTextContent("Claimed");
    expect(statusPill).not.toHaveTextContent("Exhausted");
  });

  it("routes every panel colour through a theme-aware CSS variable", async () => {
    // The panel is built from inline styles, so a hard-coded hex would render a
    // light-only surface in dark mode. Everything except the QR backdrop (which
    // must stay light in both themes so the code stays scannable) has to resolve
    // through an `--iv-*` custom property that flips under prefers-color-scheme.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisStatus());
      if (cmd === "list_contacts") return Promise.resolve([]);
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    await screen.findByTestId("invite-genesis-badge");
    fireEvent.click(screen.getByTestId("invite-issue-button"));
    expect(screen.getByTestId("invite-modal")).toBeInTheDocument();

    // The modal surface and its text colour must both be variables, otherwise
    // the dialog stays white-on-white / black-on-black under a dark theme.
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.background).toContain("var(--iv-surface");
    expect(dialog.style.color).toContain("var(--iv-text");

    // Sweep every element inside the panel for a stray hex literal.
    const offenders: string[] = [];
    for (const el of Array.from(
      screen.getByTestId("invite-manager").querySelectorAll<HTMLElement>("*"),
    )) {
      const css = el.getAttribute("style") ?? "";
      for (const prop of ["color", "background"]) {
        const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(css);
        const value = match?.[1]?.trim();
        if (value && /^#[0-9a-f]{3,8}$/i.test(value)) {
          offenders.push(`${el.tagName.toLowerCase()}[${el.dataset.testid ?? "?"}].${prop}=${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("renders a known --iv-* token set so the dark palette stays in sync", async () => {
    // Paired with the "no stray hex" test above, this pins the exact token set
    // the panel depends on. Both names must exist in the `:root` *and* the
    // `prefers-color-scheme: dark` blocks of App.css; a token defined in only
    // one of them silently falls back to its light literal at runtime.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisStatus());
      if (cmd === "list_contacts") return Promise.resolve([]);
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    await screen.findByTestId("invite-genesis-badge");
    fireEvent.click(screen.getByTestId("invite-issue-button"));

    const used = new Set<string>();
    for (const el of Array.from(
      screen.getByTestId("invite-manager").querySelectorAll<HTMLElement>("*"),
    )) {
      for (const m of (el.getAttribute("style") ?? "").matchAll(/var\(--iv-([a-z0-9-]+)/g)) {
        used.add(m[1]);
      }
    }

    // Every colour-bearing token the Genesis panel path touches.
    expect([...used].sort()).toEqual(
      [
        "border",
        "border-row",
        "danger-fg",
        "genesis-bg",
        "genesis-border",
        "genesis-fg",
        "heading",
        "ok-bg",
        "ok-border",
        "ok-fg",
        "overlay",
        "surface",
        "surface-sunken",
        "text",
        "text-muted",
      ].sort(),
    );
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

describe("InviteManager — Genesis / Operator standing", () => {
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

    // Capability badge reads "Genesis Cohort Sponsor", removing redundant "Genesis / Operator".
    await waitFor(() => {
      expect(screen.getByTestId("invite-genesis-badge")).toHaveTextContent("Genesis Cohort Sponsor");
    });
    expect(screen.queryByText("Genesis / Operator")).not.toBeInTheDocument();

    const panelBadge = screen.getByTestId("invite-genesis-badge");
    expect(panelBadge).toHaveTextContent("Genesis Cohort Sponsor");
    expect(panelBadge).toHaveAttribute(
      "title",
      "Unlimited token creation enabled for root network seeding.",
    );

    // No developer-facing banner anywhere.
    expect(screen.queryByTestId("invite-bypass-notice")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("bypass");

    fireEvent.click(screen.getByTestId("invite-issue-button"));
    expect(screen.getByTestId("invite-modal")).toBeInTheDocument();
    expect(screen.getByTestId("invite-modal-standing-badge")).toHaveTextContent(
      "Genesis Cohort Sponsor",
    );

    // Mint & Sign Invite is ENABLED despite 0 contacts, and the mint round-trips.
    const submit = screen.getByTestId("invite-submit");
    expect(submit).not.toBeDisabled();
    expect(submit).toHaveTextContent("Mint & Sign Invite");
    expect(submit).not.toHaveTextContent("(bypassed)");
    expect(screen.queryByTestId("invite-blocked-reason")).not.toBeInTheDocument();

    fireEvent.click(submit);
    await screen.findByTestId("invite-token-json");
    expect(mockInvoke).toHaveBeenCalledWith(
      "create_invite_token",
      expect.objectContaining({ tier: "member" }),
    );
  });

  it("hides the raw mutual-contact threshold selector for a waived issuer", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") return Promise.resolve(genesisStatus());
      if (cmd === "list_contacts") return Promise.resolve([]);
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));

    // The numeric selector is gone entirely — not merely disabled or relocated.
    expect(screen.queryByTestId("invite-threshold")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-threshold-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-threshold-summary")).not.toBeInTheDocument();
    // ...and no member requirements line, which would imply the gate applies.
    expect(screen.queryByTestId("invite-member-requirements")).not.toBeInTheDocument();
    // The Genesis capability badge still reports in the header.
    expect(screen.getByTestId("invite-genesis-badge")).toBeInTheDocument();
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
    // No capability badge for an ordinary peer.
    expect(screen.queryByTestId("invite-genesis-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-dev-badge")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("invite-issue-button"));

    expect(screen.getByTestId("invite-blocked-reason")).toHaveTextContent(
      "Issuer needs 5 mutual contacts before it can issue invites (currently 0).",
    );
    expect(screen.getByTestId("invite-submit")).toBeDisabled();
  });

  it("shows a clean requirements line instead of a raw selector for a member", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_issuer_status") {
        return Promise.resolve(
          genesisStatus({
            is_genesis: false,
            account_age_days: 90,
            account_age_ok: true,
            contact_count: 7,
            contacts_ok: true,
            eligible: true,
            bypass_reason: null,
          }),
        );
      }
      if (cmd === "list_contacts") {
        return Promise.resolve(
          Array.from({ length: 7 }, (_, i) => ({ peer_id: `peer-${i}` })),
        );
      }
      return defaultHandler(cmd);
    });

    render(<InviteManager />);
    fireEvent.click(await screen.findByTestId("invite-issue-button"));

    // The plain-language summary is the headline requirement display.
    expect(screen.getByTestId("invite-member-requirements")).toHaveTextContent(
      "Requires account age ≥ 14d and ≥ 5 mutual contacts.",
    );
    // The numeric control is retained, but tucked behind a disclosure rather
    // than dominating the mint form.
    expect(screen.getByTestId("invite-threshold-summary")).toBeInTheDocument();
    expect(screen.getByTestId("invite-threshold")).toHaveValue(5);
    expect(screen.getByTestId("invite-threshold-label")).toHaveTextContent(
      "Mutual contacts required >=",
    );
    expect(screen.getByTestId("invite-threshold-label")).toHaveTextContent(
      "current: 7",
    );
    // No raw developer copy anywhere in the modal.
    expect(screen.getByTestId("invite-modal").textContent).not.toContain("bypass");
    expect(screen.getByTestId("invite-modal").textContent).not.toContain("Member vetting:");
  });

  it("persists a lowered threshold through set_vetting_threshold", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_issuer_status") {
        return Promise.resolve(
          genesisStatus({
            is_genesis: false,
            account_age_days: 90,
            account_age_ok: true,
            contact_count: 7,
            contacts_ok: true,
            eligible: true,
            bypass_reason: null,
          }),
        );
      }
      if (cmd === "list_contacts") {
        return Promise.resolve(
          Array.from({ length: 7 }, (_, i) => ({ peer_id: `peer-${i}` })),
        );
      }
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

  it("blocks a flagged Genesis issuer — no waiver overrides moderation flags", async () => {
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
      expect(screen.getByTestId("invite-genesis-badge")).toHaveTextContent("Genesis Cohort Sponsor");
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
    expect(submit).toHaveTextContent("Mint & Sign Invite");

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

describe("InviteManager — dev build affordance", () => {
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
      expect(screen.getByTestId("invite-dev-badge")).toBeInTheDocument();
    });
    expect(screen.getByTestId("invite-dev-badge")).toHaveTextContent("Development Build");
    expect(screen.getByTestId("invite-dev-badge")).toHaveAttribute(
      "title",
      expect.stringContaining("enclave still enforces its own issuance policy"),
    );
    expect(screen.queryByTestId("invite-genesis-badge")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("bypass");

    fireEvent.click(screen.getByTestId("invite-issue-button"));
    expect(screen.getByTestId("invite-submit")).not.toBeDisabled();
  });
});
