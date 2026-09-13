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
import PersonaMatrix from "../components/enclave/PersonaMatrix";
import type { Profile } from "../lib/types";

const mockProfiles: Profile[] = [
  {
    profile_id: "anchor",
    profile_name: "Anchor Root",
    derivation_index: 0,
    did: "did:key:z6MkAnchor00000000000000000000000000",
    level: 0,
    is_system_reserved: true,
  },
  {
    profile_id: "primary",
    profile_name: "Primary Persona",
    derivation_index: 1,
    did: "did:key:z6MkPrimary11111111111111111111111111",
    level: 1,
    is_system_reserved: false,
  },
  {
    profile_id: "burner_one",
    profile_name: "Burner One",
    derivation_index: 2,
    did: "did:key:z6MkBurner22222222222222222222222222",
    level: 2,
    is_system_reserved: false,
  },
  {
    profile_id: "burner_two",
    profile_name: "Burner Two",
    derivation_index: 3,
    did: "did:key:z6MkBurner33333333333333333333333333",
    level: 2,
    is_system_reserved: false,
  },
];

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string) => {
    switch (cmd) {
      case "list_roles":
        return Promise.resolve([]);
      case "list_businesses":
        return Promise.resolve([]);
      case "set_active_profile":
        return Promise.resolve();
      default:
        return Promise.resolve();
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

describe("PersonaMatrix - Active Persona Visual Clarity", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("renders active card with glowing border ring-2 ring-emerald-500 and ACTIVE IDENTITY badge", async () => {
    const onRefresh = vi.fn();
    // Primary is active
    render(
      <PersonaMatrix
        profiles={mockProfiles}
        activeDid="did:key:z6MkPrimary11111111111111111111111111"
        onRefresh={onRefresh}
      />,
    );

    // Primary card should have active identity pill badge
    const activeBadge = screen.getByText("ACTIVE IDENTITY");
    expect(activeBadge).toBeInTheDocument();
    expect(activeBadge).toHaveClass("active-identity-pill");

    // The primary persona card container should have the glowing border classes
    const primaryCard = activeBadge.closest(".persona-card");
    expect(primaryCard).toBeInTheDocument();
    expect(primaryCard).toHaveClass("ring-2");
    expect(primaryCard).toHaveClass("ring-emerald-500");

    // Inactive burner cards must have distinct 'Set as Active' buttons
    const setAsActiveBtns = screen.getAllByRole("button", { name: "Set as Active" });
    expect(setAsActiveBtns.length).toBe(2); // burner_one and burner_two
  });

  it("highlights active burner persona with ring-2 ring-emerald-500 and ACTIVE IDENTITY badge", async () => {
    const onRefresh = vi.fn();
    // Burner one is active
    render(
      <PersonaMatrix
        profiles={mockProfiles}
        activeDid="did:key:z6MkBurner22222222222222222222222222"
        onRefresh={onRefresh}
      />,
    );

    // Active identity badge on Burner One
    const activeBadge = screen.getByText("ACTIVE IDENTITY");
    expect(activeBadge).toBeInTheDocument();

    const activeCard = activeBadge.closest(".persona-card");
    expect(activeCard).toBeInTheDocument();
    expect(activeCard).toHaveClass("ring-2");
    expect(activeCard).toHaveClass("ring-emerald-500");

    // Primary and burner_two should have 'Set as Active' buttons
    const setAsActiveBtns = screen.getAllByRole("button", { name: "Set as Active" });
    expect(setAsActiveBtns.length).toBe(2); // primary and burner_two
  });

  it("calls set_active_profile when Set as Active is clicked on an inactive persona", async () => {
    const onRefresh = vi.fn();
    const onSetActive = vi.fn();

    render(
      <PersonaMatrix
        profiles={mockProfiles}
        activeDid="did:key:z6MkPrimary11111111111111111111111111"
        onRefresh={onRefresh}
        onSetActiveProfile={onSetActive}
      />,
    );

    const setAsActiveBtns = screen.getAllByRole("button", { name: "Set as Active" });
    // Click Set as Active on the first inactive burner
    await act(async () => {
      fireEvent.click(setAsActiveBtns[0]);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("set_active_profile", {
        profileId: "burner_one",
      });
      expect(onSetActive).toHaveBeenCalledWith(
        expect.objectContaining({ profile_id: "burner_one" }),
      );
    });
  });
});
