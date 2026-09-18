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
import AdminPanel from "../components/admin/AdminPanel";
import type {
  AdminProbeResult,
  BanRecord,
  InviteRecord,
  MemberRecord,
  ModerationAction,
} from "../lib/types";

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const { mockInvoke, defaultHandler, state, MEMBER_DID } = vi.hoisted(() => {
  const ADMIN_DID = "did:key:z6Mkadmin123";
  const MEMBER_DID = "did:key:z6Mkmember01";
  const state = {
    authorized: true as boolean,
    members: [
      {
        did: ADMIN_DID,
        joined_at: 1700000000,
        referrer_did: null,
        invite_nonce: null,
        flags: 0,
        status: "active",
      },
      {
        did: MEMBER_DID,
        joined_at: 1700100000,
        referrer_did: ADMIN_DID,
        invite_nonce: "aa11bb22cc33dd44ee55ff6677889900",
        flags: 0,
        status: "active",
      },
    ] as MemberRecord[],
    bans: [] as BanRecord[],
    actions: [
      {
        action_id: 1,
        kind: "ban",
        subject_did: MEMBER_DID,
        actor_did: ADMIN_DID,
        payload: "{\"scope\":\"node\"}",
        created_at: 1700200000,
      },
    ] as ModerationAction[],
    invites: [
      {
        nonce: "aa11bb22cc33dd44ee55ff6677889900",
        token_json: "{}",
        issuer_did: ADMIN_DID,
        tier: "member",
        created_at: 1700000000,
        expires_at: 1710000000,
        child_did: MEMBER_DID,
        uses_count: 1,
        max_uses: 1,
        status: "used",
      },
    ] as InviteRecord[],
  };

  const handler: InvokeHandler = (cmd, args) => {
    switch (cmd) {
      case "admin_probe":
        return Promise.resolve<AdminProbeResult>({
          authorized: state.authorized,
          admin_did: state.authorized ? ADMIN_DID : null,
          satellite_id: null,
        });
      case "admin_list_members":
        return Promise.resolve(state.members);
      case "admin_list_bans":
        return Promise.resolve(state.bans);
      case "admin_list_actions":
        return Promise.resolve(state.actions);
      case "list_invites":
        return Promise.resolve(state.invites);
      case "admin_sever":
        return Promise.resolve(0);
      case "admin_ban": {
        const argsAny = args as Record<string, unknown>;
        const did = String(argsAny.targetDid);
        state.bans = [
          {
            event_id: 7,
            did,
            ban_reason: String(argsAny.reason ?? "Spam"),
            banned_by_did: ADMIN_DID,
            banned_at: Math.floor(Date.now() / 1000),
            expires_at: (argsAny.expiresAt as number | null) ?? null,
            evidence_sha256: null,
            scope: String(argsAny.scope ?? "node"),
            severed_conns: 0,
            active: true,
            unbanned_at: null,
          },
        ];
        state.members = state.members.map((m) =>
          m.did === did ? { ...m, status: "banned" } : m,
        );
        return Promise.resolve({
          ban_id: 7,
          did,
          severed_conns: 0,
          pruned_tokens: 1,
          tombstones: 2,
          blobs_deleted: 1,
          events_broadcast: 1,
        });
      }
      case "admin_unban":
        state.bans = [];
        state.members = state.members.map((m) =>
          m.did === (args as Record<string, unknown>).targetDid ? { ...m, status: "active" } : m,
        );
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  };

  return { mockInvoke: vi.fn<InvokeHandler>(handler), defaultHandler: handler, state, MEMBER_DID };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

describe("AdminPanel (RFC-003)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(defaultHandler);
    state.authorized = true;
    state.bans = [];
    state.members = state.members.map((m) =>
      m.did === MEMBER_DID ? { ...m, status: "active" } : m,
    );
  });

  it("renders a lock badge when the active L1 DID is not an admin_did", async () => {
    state.authorized = false;
    render(<AdminPanel />);

    expect(await screen.findByTestId("admin-lock-badge")).toBeInTheDocument();
    expect(screen.getByText(/Admin access locked/)).toBeInTheDocument();
    expect(screen.queryByTestId("admin-tab-members")).not.toBeInTheDocument();
    expect(mockInvoke).not.toHaveBeenCalledWith("admin_list_members", expect.anything());
  });

  it("lists members with joined dates, referrers and status pills", async () => {
    render(<AdminPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-role")).toHaveTextContent("role: ADMIN");
    });
    expect(await screen.findByTestId(`member-row-${MEMBER_DID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`member-status-${MEMBER_DID}`)).toHaveTextContent("active");
    expect(screen.getByTestId(`admin-ban-${MEMBER_DID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`admin-sever-${MEMBER_DID}`)).toBeInTheDocument();
  });

  it("severs a member and refreshes the directory", async () => {
    render(<AdminPanel />);
    const severBtn = await screen.findByTestId(`admin-sever-${MEMBER_DID}`);
    fireEvent.click(severBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("admin_sever", {
        satelliteId: "",
        targetDid: MEMBER_DID,
      });
    });
  });

  it("opens the ban modal, enforces with 1-click defaults and shows the report", async () => {
    render(<AdminPanel />);
    fireEvent.click(await screen.findByTestId(`admin-ban-${MEMBER_DID}`));

    const modal = screen.getByTestId("ban-modal");
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId("ban-target-did")).toHaveTextContent(MEMBER_DID);

    // Defaults: prune + purge checked, permanent expiry, Spam preset.
    expect((screen.getByTestId("ban-prune-branch") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("ban-purge-content") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("ban-reason-preset") as HTMLSelectElement).value).toBe("Spam");
    expect((screen.getByTestId("ban-expiry") as HTMLSelectElement).value).toBe("Permanent");

    fireEvent.click(screen.getByTestId("ban-execute"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "admin_ban",
        expect.objectContaining({
          satelliteId: "",
          targetDid: MEMBER_DID,
          reason: "Spam",
          scope: "node",
          expiresAt: null,
          pruneBranch: true,
          purgeContent: true,
          evidenceHashes: [],
        }),
      );
    });

    expect(await screen.findByTestId("ban-report-summary")).toHaveTextContent(
      "2 event(s) tombstoned",
    );
    fireEvent.click(screen.getByTestId("ban-done"));
    expect(await screen.findByTestId(`member-status-${MEMBER_DID}`)).toHaveTextContent("banned");
  });

  it("passes preset reason, expiry windows, scope and evidence to admin_ban", async () => {
    render(<AdminPanel />);
    fireEvent.click(await screen.findByTestId(`admin-ban-${MEMBER_DID}`));

    fireEvent.change(screen.getByTestId("ban-reason-preset"), {
      target: { value: "Harassment" },
    });
    fireEvent.change(screen.getByTestId("ban-expiry"), { target: { value: "7 Days" } });
    fireEvent.change(screen.getByTestId("ban-scope"), { target: { value: "federated" } });
    fireEvent.change(screen.getByTestId("ban-evidence"), {
      target: { value: "aaa, bbb" },
    });
    fireEvent.click(screen.getByTestId("ban-execute"));

    await waitFor(() => {
      const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "admin_ban");
      expect(call).toBeDefined();
      const args = call![1] as Record<string, unknown>;
      expect(args.reason).toBe("Harassment");
      expect(args.scope).toBe("federated");
      expect(args.evidenceHashes).toEqual(["aaa", "bbb"]);
      const expiresAt = args.expiresAt as number;
      const now = Math.floor(Date.now() / 1000);
      expect(expiresAt).toBeGreaterThan(now + 6 * 86400);
      expect(expiresAt).toBeLessThanOrEqual(now + 7 * 86400 + 60);
    });
  });

  it("shows the active bans table and unban refreshes the ledger", async () => {
    render(<AdminPanel />);
    fireEvent.click(await screen.findByTestId("admin-tab-bans"));

    // Seed a ban through the ban flow first so the ledger has a row.
    fireEvent.click(await screen.findByTestId("admin-tab-members"));
    fireEvent.click(await screen.findByTestId(`admin-ban-${MEMBER_DID}`));
    fireEvent.click(await screen.findByTestId("ban-execute"));
    await screen.findByTestId("ban-report-summary");
    fireEvent.click(screen.getByTestId("ban-done"));

    fireEvent.click(screen.getByTestId("admin-tab-bans"));
    expect(await screen.findByTestId(`admin-ban-row-${MEMBER_DID}`)).toBeInTheDocument();
    expect(screen.getByTestId("admin-audit-row-1")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`admin-unban-${MEMBER_DID}`));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("admin_unban", {
        satelliteId: "",
        targetDid: MEMBER_DID,
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`admin-ban-row-${MEMBER_DID}`)).not.toBeInTheDocument();
    });
  });

  it("renders the invite referral graph from RFC-002 records", async () => {
    render(<AdminPanel />);
    fireEvent.click(await screen.findByTestId("admin-tab-graph"));

    const row = await screen.findByTestId("admin-graph-row-aa11bb22cc33dd44ee55ff6677889900");
    expect(row).toHaveTextContent("used");
    expect(row).toHaveTextContent("member");
    expect(screen.getByTestId("admin-graph-status-aa11bb22cc33dd44ee55ff6677889900")).toHaveTextContent("used");
  });
});