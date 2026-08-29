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

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MessagesTab from "../components/MessagesTab";
import type { ChatPeerTarget } from "../lib/types";

const HEX = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const NPUB = "npub142aueh0wluqpzg3ng32kvaugnx4thnxaamlsqyfzxdz92enh3zvsm2mwpp";

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string) => {
    switch (cmd) {
      case "list_contacts":
        return Promise.resolve([]);
      default:
        return Promise.resolve(undefined);
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("MessagesTab", () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    localStorage.clear();
  });

  it("renders the empty inbox placeholder and New Chat entry point", () => {
    render(<MessagesTab initialPeer={null} onClearInitialPeer={() => {}} />);
    expect(
      screen.getByText("Select a conversation or start a new encrypted chat"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start New Chat/i })).toBeInTheDocument();
    expect(screen.getByText("Conversations")).toBeInTheDocument();
  });

  it("keeps Start Conversation disabled until a valid address is entered", async () => {
    render(<MessagesTab initialPeer={null} onClearInitialPeer={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start New Chat/i }));
    });

    const input = screen.getByPlaceholderText(/did:key/i);
    const submit = screen.getByRole("button", { name: "Start Conversation" });
    expect(submit).toBeDisabled();

    await act(async () => {
      fireEvent.change(input, { target: { value: "not-a-valid-identifier" } });
    });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/Unrecognized identifier/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(input, { target: { value: NPUB } });
    });
    expect(submit).toBeEnabled();
    expect(screen.getByText(/Will route to/)).toBeInTheDocument();
  });

  it("starts a thread from an npub and surfaces it in the inbox", async () => {
    render(<MessagesTab initialPeer={null} onClearInitialPeer={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Conversations")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start New Chat/i }));
    });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/did:key/i), {
        target: { value: NPUB },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Conversation" }));
    });

    await waitFor(() => {
      expect(screen.queryByText("💬 Start a New Encrypted Chat")).not.toBeInTheDocument();
      expect(screen.getAllByText(/aabbccdd…778899/).length).toBeGreaterThan(0);
    });
  });

  it("opens a thread focused for an initial peer handed off from the Enclave", async () => {
    const target: ChatPeerTarget = { peerId: HEX, displayName: "Alice Sanctum" };
    render(<MessagesTab initialPeer={target} onClearInitialPeer={() => {}} />);

    await waitFor(() => {
      expect(screen.getAllByText("Alice Sanctum").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Conversations")).toBeInTheDocument();
  });

  it("persists threads to localStorage and restores them on remount", async () => {
    const { unmount } = render(
      <MessagesTab initialPeer={null} onClearInitialPeer={() => {}} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Start New Chat/i }));
    });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/did:key/i), {
        target: { value: NPUB },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Conversation" }));
    });

    await waitFor(() => {
      expect(screen.getAllByText(/aabbccdd…778899/).length).toBeGreaterThan(0);
    });

    unmount();
    render(<MessagesTab initialPeer={null} onClearInitialPeer={() => {}} />);

    await waitFor(() => {
      expect(screen.getAllByText(/aabbccdd…778899/).length).toBeGreaterThan(0);
    });
  });
});