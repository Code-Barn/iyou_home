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
import { isAnchor, isExternallySignable } from "../lib/enclaveFilters";
import { Profile } from "../lib/types";

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
  });
});
