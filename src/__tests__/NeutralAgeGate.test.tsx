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
import NeutralAgeGate from "../components/onboarding/NeutralAgeGate";
import type {
  AgeGateRecord,
  AgeTier,
  DisclaimerAuditEntry,
} from "../lib/types";

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const { mockInvoke, state } = vi.hoisted(() => {
  const state = {
    tier: "adult" as AgeTier,
    recordedEntry: null as DisclaimerAuditEntry | null,
  };

  const handler: InvokeHandler = (cmd, args) => {
    switch (cmd) {
      case "classify_age":
        return Promise.resolve(state.tier);
      case "record_disclaimer_audit": {
        const entry = (args as Record<string, unknown>).entry as DisclaimerAuditEntry;
        state.recordedEntry = entry;
        return Promise.resolve();
      }
      default:
        return Promise.resolve();
    }
  };

  return { mockInvoke: vi.fn<InvokeHandler>(handler), state };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const selectByValue = (testId: string, value: string) => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};

const pickAdultGate = () => {
  selectByValue("age-gate-month", "9");
  selectByValue("age-gate-year", "2005");
};

describe("NeutralAgeGate (RFC-004)", () => {
  beforeEach(() => {
    state.tier = "adult";
    state.recordedEntry = null;
    mockInvoke.mockClear();
  });

  test("Continue is disabled until both dropdowns are selected", () => {
    render(
      <NeutralAgeGate onDecision={vi.fn()} onNeedsParentPairing={vi.fn()} />,
    );
    const btn = screen.getByTestId("age-gate-continue") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    selectByValue("age-gate-month", "9");
    expect((screen.getByTestId("age-gate-continue") as HTMLButtonElement).disabled).toBe(true);

    selectByValue("age-gate-year", "2005");
    expect((screen.getByTestId("age-gate-continue") as HTMLButtonElement).disabled).toBe(false);
  });

  test("year options ascend from 1920 to the current year (no youngest-first bias)", () => {
    render(
      <NeutralAgeGate onDecision={vi.fn()} onNeedsParentPairing={vi.fn()} />,
    );
    const yearSelect = screen.getByTestId("age-gate-year") as HTMLSelectElement;
    const options = Array.from(yearSelect.options).map((o) => Number(o.value));
    const valid = options.filter((v) => !Number.isNaN(v) && v > 0);
    expect(valid[0]).toBe(1920);
    expect(valid[valid.length - 1]).toBe(new Date().getFullYear());
    expect(valid).toEqual([...valid].sort((a, b) => a - b));
  });

  test("renders exactly two inputs with zero bracket-revealing copy", () => {
    render(
      <NeutralAgeGate onDecision={vi.fn()} onNeedsParentPairing={vi.fn()} />,
    );
    const selects = screen.getAllByRole("combobox");
    expect(selects.length).toBe(2);

    const body = document.body.textContent ?? "";
    expect(body.toLowerCase()).not.toContain("you are");
    expect(body.toLowerCase()).not.toContain("years old");
    expect(body.toLowerCase()).not.toContain("age:");
  });

  test("adult branch calls onDecision with the sealed record and proceeds", async () => {
    state.tier = "adult";
    const onDecision = vi.fn();
    render(
      <NeutralAgeGate onDecision={onDecision} onNeedsParentPairing={vi.fn()} />,
    );
    pickAdultGate();
    fireEvent.click(screen.getByTestId("age-gate-continue"));

    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(1));
    const record = onDecision.mock.calls[0][0] as AgeGateRecord;
    expect(record.tier).toBe("adult");
    expect(record.month).toBe(9);
    expect(record.year).toBe(2005);
    expect(record.gate_version).toBe("neutral-v1");
    expect(typeof record.computed_at).toBe("number");
    // No disclaimer recorded for the direct adult path.
    expect(state.recordedEntry).toBeNull();
  });

  test("teen branch shows the privacy advisory and logs coppa-teen-safety-v1 before deciding", async () => {
    state.tier = "teen";
    const onDecision = vi.fn();
    render(
      <NeutralAgeGate onDecision={onDecision} onNeedsParentPairing={vi.fn()} />,
    );
    pickAdultGate();
    fireEvent.click(screen.getByTestId("age-gate-continue"));

    // Advisory is shown; decision is NOT emitted yet.
    await waitFor(() =>
      expect(screen.getByTestId("age-gate-teen-advisory")).toBeInTheDocument(),
    );
    expect(onDecision).not.toHaveBeenCalled();
    expect(
      screen.getByText(/direct messages are restricted to mutual contacts/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("age-gate-teen-acknowledge"));
    await waitFor(() => expect(onDecision).toHaveBeenCalledTimes(1));
    expect(onDecision.mock.calls[0][0].tier).toBe("teen");
    expect(mockInvoke).toHaveBeenCalledWith("record_disclaimer_audit", {
      entry: expect.objectContaining({
        disclaimer_key: "coppa-teen-safety-v1",
        outcome: "accepted",
        context: "onboarding",
      }) as unknown,
    });
    expect(state.recordedEntry?.disclaimer_key).toBe("coppa-teen-safety-v1");
    expect(state.recordedEntry?.outcome).toBe("accepted");
    expect(state.recordedEntry?.disclaimer_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("child branch halts seed generation and offers parent pairing only", async () => {
    state.tier = "child";
    const onDecision = vi.fn();
    const onNeedsParentPairing = vi.fn();
    render(
      <NeutralAgeGate onDecision={onDecision} onNeedsParentPairing={onNeedsParentPairing} />,
    );
    pickAdultGate();
    fireEvent.click(screen.getByTestId("age-gate-continue"));

    await waitFor(() =>
      expect(screen.getByTestId("age-gate-child-card")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        /To setup an identity for an individual under 13, please pair this device with a parent or guardian/i,
      ),
    ).toBeInTheDocument();
    // Seed generation is never reached from the gate itself.
    expect(onDecision).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("age-gate-pair-parent"));
    expect(onNeedsParentPairing).toHaveBeenCalledTimes(1);
  });

  test("classification failure shows a neutral re-check message, never a tier hint", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("out_of_range"));
    const onDecision = vi.fn();
    render(
      <NeutralAgeGate onDecision={onDecision} onNeedsParentPairing={vi.fn()} />,
    );
    pickAdultGate();
    fireEvent.click(screen.getByTestId("age-gate-continue"));

    await waitFor(() =>
      expect(screen.getByTestId("age-gate-neutral-error")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Please re-check the selected date/i),
    ).toBeInTheDocument();
    expect(onDecision).not.toHaveBeenCalled();
    const body = document.body.textContent ?? "";
    expect(body.toLowerCase()).not.toContain("child");
    expect(body.toLowerCase()).not.toContain("teen");
    expect(body.toLowerCase()).not.toContain("adult");
  });
});