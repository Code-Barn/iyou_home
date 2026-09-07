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

import { describe, it, expect } from "vitest";
import { isAnchor, isExternallySignable, isRoleProfile, isBusinessProfile } from "../lib/enclaveFilters";
import { Profile, RoleProfile, BusinessProfile } from "../lib/types";

describe("enclaveFilters", () => {
  const anchorProfile: Profile = {
    profile_id: "anchor",
    profile_name: "Anchor Identity",
    derivation_index: 0,
    did: "did:key:z6MkAnchor00000000000000000000000000",
    level: 0,
    is_system_reserved: true,
  };

  const primaryProfile: Profile = {
    profile_id: "primary",
    profile_name: "Public Persona",
    derivation_index: 1,
    did: "did:key:z6MkPrimary11111111111111111111111111",
    level: 1,
    is_system_reserved: false,
    nostr_pubkey_hex: "1111111111111111111111111111111111111111111111111111111111111111",
  };

  const burnerProfile: Profile = {
    profile_id: "burner_alpha",
    profile_name: "Burner Alpha",
    derivation_index: 2,
    did: "did:key:z6MkBurner22222222222222222222222222",
    level: 2,
    is_system_reserved: false,
    nostr_pubkey_hex: "2222222222222222222222222222222222222222222222222222222222222222",
  };

  it("identifies Level 0 / index 0 / system reserved profiles as anchors", () => {
    expect(isAnchor(anchorProfile)).toBe(true);
    expect(isAnchor({ ...primaryProfile, level: 0 })).toBe(true);
    expect(isAnchor({ ...primaryProfile, derivation_index: 0 })).toBe(true);
    expect(isAnchor({ ...primaryProfile, is_system_reserved: true })).toBe(true);
  });

  it("identifies Level 1 and Level 2+ profiles as non-anchors", () => {
    expect(isAnchor(primaryProfile)).toBe(false);
    expect(isAnchor(burnerProfile)).toBe(false);
  });

  it("correctly identifies externally signable profiles", () => {
    expect(isExternallySignable(anchorProfile)).toBe(false);
    expect(isExternallySignable(primaryProfile)).toBe(true);
    expect(isExternallySignable(burnerProfile)).toBe(true);
    // Any hypothetical profile that is not level 1 or 2 must not be externally signable
    expect(isExternallySignable({ ...burnerProfile, level: 0 })).toBe(false);
  });

  it("validates role and business profile type guards", () => {
    const role: RoleProfile = {
      role_id: "role_lead",
      role_title: "Tech Lead",
      namespace: "core.eng",
      role_index: 0,
      did: "did:key:z6MkRole33333333333333333333333333",
      nostr_pubkey_hex: "3333333333333333333333333333333333333333333333333333333333333333",
      organization_did: "did:key:z6MkOrg44444444444444444444444444",
      delegation_scope: ["sign_reviews"],
      level: 3,
      created_at: Date.now(),
    };

    const business: BusinessProfile = {
      business_id: "biz_corp",
      legal_name: "Byers Brands LLC",
      business_index: 0,
      did: "did:key:z6MkBiz55555555555555555555555555",
      nostr_pubkey_hex: "5555555555555555555555555555555555555555555555555555555555555555",
      jurisdiction: "US-DE",
      operating_currency: "USD",
      merchant_endpoints: ["https://merchant.iyou.me"],
      level: 4,
      created_at: Date.now(),
    };

    expect(isRoleProfile(role)).toBe(true);
    expect(isRoleProfile(business as any)).toBe(false);
    expect(isRoleProfile(primaryProfile as any)).toBe(false);

    expect(isBusinessProfile(business)).toBe(true);
    expect(isBusinessProfile(role as any)).toBe(false);
    expect(isBusinessProfile(primaryProfile as any)).toBe(false);
  });
});
