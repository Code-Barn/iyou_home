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
import App from "../App";

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_auto_start_settings":
        return Promise.resolve({ Blossom: true, Nostr: true, Chat: true });
      case "get_service_statuses":
        return Promise.resolve({
          SigBridge: "running",
          Blossom: "stopped",
          Nostr: "stopped",
          Chat: "stopped",
          "IPFS Cloud Archive": "stopped",
          Polly: "stopped",
        });
      case "toggle_service":
        return new Promise((resolve) =>
          setTimeout(
            () => resolve(args?.action === "stop" ? "stopped" : "running"),
            0,
          ),
        );
      default:
        return Promise.resolve();
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  Channel: vi.fn().mockImplementation(() => ({
    onmessage: null,
  })),
}));

describe("App", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  it("renders the service switch panel", () => {
    render(<App />);
    expect(screen.getByText("Service Switch Panel")).toBeInTheDocument();
    expect(screen.getByText("SigBridge")).toBeInTheDocument();
    expect(screen.getByText("Nostr")).toBeInTheDocument();
    expect(screen.getByText("Blossom")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getAllByText("IPFS Cloud Archive").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Polly")).toBeInTheDocument();
  });

  it("shows ports for active services", () => {
    render(<App />);
    expect(screen.getByText(":9001")).toBeInTheDocument();
    expect(screen.getByText(":9002")).toBeInTheDocument();
    expect(screen.getByText(":9003")).toBeInTheDocument();
    expect(screen.getByText(":5222")).toBeInTheDocument();
  });

  it("calls the toggle_service command when a start button is clicked", async () => {
    render(<App />);

    const startButtons = screen.getAllByRole("button", {
      name: /start/i,
    });
    expect(startButtons.length).toBe(3);

    await act(async () => {
      fireEvent.click(startButtons[0]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("toggle_service", {
        name: "Blossom",
        action: "start",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });
  });

  it("handles service stop correctly", async () => {
    render(<App />);

    const startButtons = screen.getAllByRole("button", {
      name: /start/i,
    });
    await act(async () => {
      fireEvent.click(startButtons[0]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });

    const stopButton = screen.getByText("Stop");
    await act(async () => {
      fireEvent.click(stopButton);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("toggle_service", {
        name: "Blossom",
        action: "stop",
      });
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /start/i }).length).toBe(3);
    });
  });
});
