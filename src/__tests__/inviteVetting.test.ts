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

import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_NOTICE,
  MAX_CONTACTS_CEILING,
  MIN_CONTACTS_FLOOR,
  clampThreshold,
  deriveInviteStanding,
} from "../components/invites/inviteVetting";
import type { IssuerStatus } from "../lib/types";

function issuer(overrides: Partial<IssuerStatus> = {}, vetting: Partial<IssuerStatus["vetting"]> = {}): IssuerStatus {
  return {
    did: "did:key:z6Mkprimary",
    role: "member",
    quota_used_last_30d: 0,
    quota_limit: 3,
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
      ...vetting,
    },
    ...overrides,
  };
}

describe("clampThreshold", () => {
  it("never allows the anti-Sybil gate to be configured away", () => {
    expect(clampThreshold(0)).toBe(MIN_CONTACTS_FLOOR);
    expect(clampThreshold(-10)).toBe(MIN_CONTACTS_FLOOR);
    expect(clampThreshold(1)).toBe(1);
    expect(clampThreshold(5)).toBe(5);
    expect(clampThreshold(999)).toBe(MAX_CONTACTS_CEILING);
    expect(clampThreshold(Number.NaN)).toBe(MIN_CONTACTS_FLOOR);
  });

  it("truncates fractional input", () => {
    expect(clampThreshold(3.9)).toBe(3);
  });
});

describe("deriveInviteStanding — Genesis / Operator bypass", () => {
  it("reports Genesis / Operator tier and lifts the bootstrap contact gate", () => {
    // The chicken-and-egg case: root identity, empty contact book, no account age.
    const standing = deriveInviteStanding({
      issuer: issuer({}, {
        contact_count: 0,
        contacts_ok: false,
        contacts_remaining: 5,
        account_age_days: 0,
        account_age_ok: false,
        is_genesis: true,
        bypass_reason: `${BOOTSTRAP_NOTICE} (Genesis / Operator identity, 0 contact(s) — threshold 5 not applied)`,
      }),
      devMode: false,
      contactCount: 0,
    });

    expect(standing.is_genesis).toBe(true);
    expect(standing.bypassed).toBe(true);
    expect(standing.tier_label).toBe("Genesis / Operator");
    expect(standing.can_mint).toBe(true);
    expect(standing.blocked_reason).toBeNull();
    expect(standing.notice).toContain("Operator bootstrap mode: mutual vetting bypassed");
  });

  it("prefers the enclave-supplied bypass reason verbatim", () => {
    const supplied = `${BOOTSTRAP_NOTICE} (from the enclave)`;
    const standing = deriveInviteStanding({
      issuer: issuer({}, { is_genesis: true, bypass_reason: supplied }),
      devMode: false,
      contactCount: 0,
    });
    expect(standing.notice).toBe(supplied);
  });

  it("synthesises a notice when the enclave supplies none", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({}, { is_genesis: true, bypass_reason: null }),
      devMode: false,
      contactCount: 0,
    });
    expect(standing.notice).toContain(BOOTSTRAP_NOTICE);
    expect(standing.notice).toContain("empty contact book");
  });

  it("treats an Admin issuer as bypassed", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({ role: "admin", quota_limit: 0 }, { contacts_ok: false }),
      devMode: false,
      contactCount: 0,
    });
    expect(standing.is_admin).toBe(true);
    expect(standing.bypassed).toBe(true);
    expect(standing.tier_label).toBe("Admin");
    expect(standing.can_mint).toBe(true);
  });
});

describe("deriveInviteStanding — ordinary peers stay gated", () => {
  it("blocks a member below the contact threshold and explains why", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({}, { contact_count: 2, contacts_ok: false, contacts_remaining: 3 }),
      devMode: false,
      contactCount: 2,
    });

    expect(standing.bypassed).toBe(false);
    expect(standing.can_mint).toBe(false);
    expect(standing.notice).toBeNull();
    expect(standing.blocked_reason).toBe(
      "Member vetting: need >= 5 mutual contacts (have 2).",
    );
  });

  it("flips to permitted once the operator lowers the threshold to match", () => {
    // Same 2-contact issuer, threshold tuned from the default 5 down to 2.
    const standing = deriveInviteStanding({
      issuer: issuer({}, {
        contact_count: 2,
        contacts_ok: true,
        min_contacts_required: 2,
        contacts_remaining: 0,
      }),
      devMode: false,
      contactCount: 2,
    });
    expect(standing.can_mint).toBe(true);
    expect(standing.blocked_reason).toBeNull();
  });

  it("reflects a raised threshold in the blocked reason", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({}, {
        contact_count: 6,
        contacts_ok: false,
        min_contacts_required: 10,
        contacts_remaining: 4,
      }),
      devMode: false,
      contactCount: 6,
    });
    expect(standing.can_mint).toBe(false);
    expect(standing.blocked_reason).toBe(
      "Member vetting: need >= 10 mutual contacts (have 6).",
    );
  });

  it("permits a fully vetted member", () => {
    const standing = deriveInviteStanding({
      issuer: issuer(),
      devMode: false,
      contactCount: 6,
    });
    expect(standing.can_mint).toBe(true);
    expect(standing.blocked_reason).toBeNull();
    expect(standing.tier_label).toBe("member");
  });

  it("blocks a young account before even reaching the contact gate", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({}, { account_age_days: 3, account_age_ok: false }),
      devMode: false,
      contactCount: 6,
    });
    expect(standing.blocked_reason).toContain("Account age 3d must exceed 14d");
  });
});

describe("deriveInviteStanding — safety gates are never waived", () => {
  it("blocks a flagged Genesis issuer despite the bypass", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({}, {
        is_genesis: true,
        active_moderation_flags: 2,
        flags_ok: false,
      }),
      devMode: false,
      contactCount: 0,
    });
    expect(standing.bypassed).toBe(true);
    expect(standing.can_mint).toBe(false);
    expect(standing.blocked_reason).toContain("2 active moderation flag(s)");
  });

  it("blocks a flagged ordinary member", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({}, { active_moderation_flags: 1, flags_ok: false }),
      devMode: false,
      contactCount: 6,
    });
    expect(standing.can_mint).toBe(false);
    expect(standing.blocked_reason).toContain("moderation flag");
  });
});

describe("deriveInviteStanding — dev bypass", () => {
  it("marks a dev build as bypassing the display gate only", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({}, { contacts_ok: false, contact_count: 0 }),
      devMode: true,
      contactCount: 0,
    });
    expect(standing.dev_bypass).toBe(true);
    expect(standing.bypassed).toBe(true);
    expect(standing.can_mint).toBe(true);
    expect(standing.notice).toContain("frontend dev build");
    // Honest about the fact that the enclave still enforces its own policy.
    expect(standing.notice).toContain("the enclave still enforces its own policy");
  });

  it("does not claim a dev bypass for a genuine Genesis identity", () => {
    const standing = deriveInviteStanding({
      issuer: issuer({}, { is_genesis: true }),
      devMode: true,
      contactCount: 0,
    });
    expect(standing.dev_bypass).toBe(false);
  });
});

describe("deriveInviteStanding — loading state", () => {
  it("degrades safely while issuer status is still null", () => {
    const standing = deriveInviteStanding({ issuer: null, devMode: false, contactCount: 0 });
    expect(standing.bypassed).toBe(false);
    expect(standing.tier_label).toBe("member");
    // No data yet: fail CLOSED rather than enable minting speculatively.
    expect(standing.can_mint).toBe(false);
    expect(standing.blocked_reason).toBe("Verifying issuer standing…");
  });
});
