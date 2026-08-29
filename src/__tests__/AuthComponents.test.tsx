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
import { vi } from "vitest";
import FirstRunSeedGate from "../components/auth/FirstRunSeedGate";
import AppLockOverlay from "../components/auth/AppLockOverlay";
import { sha256Hex } from "../lib/appLock";

const TEST_SEED_HEX = "0123456789abcdefa1b2c3d4e5f60718293a4b5c6d7e8f901122334455667788";

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, _args?: Record<string, unknown>) => {
    switch (cmd) {
      case "reveal_master_seed":
        return Promise.resolve(TEST_SEED_HEX);
      case "set_seed_backup_confirmed":
        return Promise.resolve(true);
      default:
        return Promise.resolve();
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("FirstRunSeedGate", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("reveals master seed and allows confirmation via typed acknowledgment", async () => {
    const onConfirmed = vi.fn();
    render(<FirstRunSeedGate onConfirmed={onConfirmed} />);

    await waitFor(() => {
      expect(screen.getByText(/Master Seed Backup/i)).toBeInTheDocument();
      expect(
        screen.getByText((content) => content.startsWith("0123")),
      ).toBeInTheDocument();
    });

    // Switch to ack mode
    const ackToggle = screen.getByRole("button", {
      name: /Use the typed acknowledgment instead/i,
    });
    await act(async () => {
      fireEvent.click(ackToggle);
    });

    const submitBtn = screen.getByRole("button", { name: /I've Saved My Seed/i });
    expect(submitBtn).toBeDisabled();

    const input = screen.getByPlaceholderText("I HAVE SAVED MY SEED");

    // Test permissive phrase variants
    await act(async () => {
      fireEvent.change(input, { target: { value: "   i've saved my seed   " } });
    });
    expect(submitBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.change(input, { target: { value: "i saved my seed" } });
    });
    expect(submitBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.change(input, { target: { value: "I HAVE SAVED MY SEED" } });
    });
    expect(submitBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("set_seed_backup_confirmed", {
        confirmed: true,
      });
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    });
  });

  it("handles word challenge mode with uppercase/lowercase normalization and enables confirmation", async () => {
    const onConfirmed = vi.fn();
    render(<FirstRunSeedGate onConfirmed={onConfirmed} />);

    await waitFor(() => {
      expect(screen.getByText(/Verify you recorded it/i)).toBeInTheDocument();
    });

    const inputs = screen.getAllByPlaceholderText("4 hex chars");
    expect(inputs.length).toBe(3);

    // Fill all inputs with incorrect values
    for (const input of inputs) {
      await act(async () => {
        fireEvent.change(input, { target: { value: "0000" } });
        fireEvent.blur(input);
      });
    }

    const submitBtn = screen.getByRole("button", { name: /I've Saved My Seed/i });
    expect(submitBtn).toBeDisabled();

    // Check that Chunk labels are displayed (using exact regex to match label text)
    const chunkLabels = screen.getAllByText(/^Chunk #\d+$/i);
    expect(chunkLabels.length).toBe(3);

    // Enter correct values for all 3 inputs using uppercase/whitespace to test normalization
    const chunkMap: Record<string, string> = {
      "Chunk #1": "  0123  ",
      "Chunk #2": " 4567 ",
      "Chunk #3": "89AB",
      "Chunk #4": "CDEF",
      "Chunk #5": "A1B2",
      "Chunk #6": "C3D4",
      "Chunk #7": "E5F6",
      "Chunk #8": "0718",
      "Chunk #9": "293A",
      "Chunk #10": "4B5C",
      "Chunk #11": "6D7E",
      "Chunk #12": "8F90",
      "Chunk #13": "1122",
      "Chunk #14": "3344",
      "Chunk #15": "5566",
      "Chunk #16": "7788",
    };

    for (let i = 0; i < inputs.length; i++) {
      const labelText = chunkLabels[i].textContent || "";
      const expectedInput = chunkMap[labelText.trim()];
      if (expectedInput) {
        await act(async () => {
          fireEvent.change(inputs[i], { target: { value: expectedInput } });
          fireEvent.blur(inputs[i]);
        });
      }
    }

    expect(submitBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("set_seed_backup_confirmed", {
        confirmed: true,
      });
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    });
  });
});

describe("AppLockOverlay", () => {
  it("rejects incorrect PIN and unlocks on correct PIN", async () => {
    const pin = "123456";
    const pinHash = await sha256Hex(pin);
    const onUnlock = vi.fn();

    render(
      <AppLockOverlay
        pinHash={pinHash}
        prfHash={null}
        autoLockMinutes={15}
        onUnlock={onUnlock}
      />,
    );

    expect(screen.getByText("iyou_home is locked")).toBeInTheDocument();
    expect(
      screen.getByText("Auto-locks after 15 minutes of inactivity."),
    ).toBeInTheDocument();

    const input = screen.getByPlaceholderText("••••••");
    const unlockBtn = screen.getByRole("button", { name: "Unlock" });

    // Enter wrong PIN
    await act(async () => {
      fireEvent.change(input, { target: { value: "654321" } });
    });

    await act(async () => {
      fireEvent.click(unlockBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("Incorrect PIN. Try again.")).toBeInTheDocument();
      expect(onUnlock).not.toHaveBeenCalled();
    });

    // Enter correct PIN
    await act(async () => {
      fireEvent.change(input, { target: { value: pin } });
    });

    await act(async () => {
      fireEvent.click(unlockBtn);
    });

    await waitFor(() => {
      expect(onUnlock).toHaveBeenCalledTimes(1);
    });
  });
});
