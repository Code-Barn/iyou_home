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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import QuickDispatchModal, {
  OUTBOX_RELAY_ENDPOINTS,
  RELAY_ENDPOINTS,
  broadcastToRelays,
  extractHashtags,
  generateUuid,
  mapFidelityTier,
} from "../components/QuickDispatchModal";

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "list_profiles":
        return Promise.resolve([
          {
            profile_id: "primary",
            profile_name: "Primary Persona",
            did: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH",
            level: 1,
            derivation_index: 1,
            is_system_reserved: false,
          },
        ]);
      case "get_active_did":
        return Promise.resolve("did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH");
      case "dispatch_nostr_event":
        return Promise.resolve({
          id: "e0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7a8b9c0d1e2f3a4b5c",
          pubkey: "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
          created_at: 1725000000,
          kind: args?.kind ?? 1,
          tags: args?.tags ?? [],
          content: args?.content ?? "",
          sig: "abcdef0123456789",
        });
      default:
        return Promise.resolve();
    }
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("Quick Dispatch Parity & Contracts", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockInvoke.mockClear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Helper Units (extractHashtags, generateUuid, mapFidelityTier)", () => {
    it("extracts unique lowercase hashtags correctly", () => {
      const text = "Deploying node with #SovereignMesh and #mesh-network and #sovereignmesh!";
      const tags = extractHashtags(text);
      expect(tags).toEqual(["sovereignmesh", "mesh-network"]);
    });

    it("returns empty array when text has no hashtags", () => {
      expect(extractHashtags("Just a regular note with no tags")).toEqual([]);
      expect(extractHashtags("")).toEqual([]);
    });

    it("generates valid standard UUIDs", () => {
      const uuid = generateUuid();
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("maps fidelity tiers correctly to canonical 1 | 2 | 3 numerals", () => {
      expect(mapFidelityTier("social")).toBe("1");
      expect(mapFidelityTier("1")).toBe("1");
      expect(mapFidelityTier("institutional")).toBe("2");
      expect(mapFidelityTier("vetted")).toBe("2");
      expect(mapFidelityTier("2")).toBe("2");
      expect(mapFidelityTier("hardware")).toBe("3");
      expect(mapFidelityTier("sovereign")).toBe("3");
      expect(mapFidelityTier("3")).toBe("3");
      expect(mapFidelityTier("unknown")).toBe("1");
    });
  });

  describe("Multi-Relay Parallel Broadcast Topology", () => {
    it("includes local relay, project relay, and upstream default relays", () => {
      expect(OUTBOX_RELAY_ENDPOINTS).toContain("ws://127.0.0.1:9003");
      expect(OUTBOX_RELAY_ENDPOINTS).toContain("wss://relay.iyou.me");
      expect(OUTBOX_RELAY_ENDPOINTS).toContain("wss://nos.lol");
      expect(OUTBOX_RELAY_ENDPOINTS).toContain("wss://relay.damus.io");
      expect(RELAY_ENDPOINTS).toEqual(OUTBOX_RELAY_ENDPOINTS);
    });

    it("fans out in parallel across all relays without blocking on individual failures", async () => {
      const mockEvent = { id: "test-event-id", kind: 1, content: "test" };
      const results = await broadcastToRelays(mockEvent, undefined, 100);
      expect(results.length).toBeGreaterThanOrEqual(4);
      // All results are settled (fulfilled or rejected), none hang or throw
      results.forEach((res) => {
        expect(["fulfilled", "rejected"]).toContain(res.status);
      });
    });
  });

  describe("Kind 1 Note Event Tagging Parity", () => {
    it("extracts hashtags and appends omni_social_v2 client tag", async () => {
      const onClose = vi.fn();
      render(<QuickDispatchModal isOpen={true} onClose={onClose} />);

      const textarea = screen.getByPlaceholderText(/What's happening across the sovereign mesh/i);
      await act(async () => {
        fireEvent.change(textarea, {
          target: { value: "Broadcasting across the mesh #Sovereign #federation" },
        });
      });

      const dispatchBtn = screen.getByRole("button", { name: /Dispatch Note/i });
      await act(async () => {
        fireEvent.click(dispatchBtn);
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("dispatch_nostr_event", {
          kind: 1,
          content: "Broadcasting across the mesh #Sovereign #federation",
          tags: [
            ["t", "sovereign"],
            ["t", "federation"],
            ["client", "omni_social_v2"],
          ],
          profileId: "primary",
        });
        expect(screen.getByText(/Event published to mesh/i)).toBeInTheDocument();
      });
    });
  });

  describe("Kind 1063 Blossom Media Upload & NIP-94 Tag Parity", () => {
    it("uploads binary via PUT to Blossom :9002 and formats NIP-94 tags", async () => {
      const onClose = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      globalThis.fetch = mockFetch;

      render(<QuickDispatchModal isOpen={true} onClose={onClose} />);

      // Switch to Media tab
      const mediaTabBtn = screen.getByRole("button", { name: /Media \(Kind 1063\)/i });
      await act(async () => {
        fireEvent.click(mediaTabBtn);
      });

      // Simulate file selection
      const file = new File(["dummy file binary content"], "test-diagram.png", {
        type: "image/png",
      });
      file.arrayBuffer = vi.fn().mockResolvedValue(new TextEncoder().encode("dummy file binary content").buffer);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).not.toBeNull();

      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });

      const altInput = screen.getByPlaceholderText(/Describe the media payload/i);
      await act(async () => {
        fireEvent.change(altInput, { target: { value: "Topology Architecture" } });
      });

      const dispatchBtn = screen.getByRole("button", { name: /Dispatch Media/i });
      await act(async () => {
        fireEvent.click(dispatchBtn);
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("dispatch_nostr_event", expect.objectContaining({
          kind: 1063,
          content: "Topology Architecture",
          profileId: "primary",
        }));
      });

      // Verify NIP-94 tags structure
      const invokeCall = mockInvoke.mock.calls.find(
        (c) => c[0] === "dispatch_nostr_event" && c[1]?.kind === 1063,
      );
      expect(invokeCall).toBeDefined();
      const tags: string[][] = invokeCall![1].tags;

      const urlTag = tags.find((t) => t[0] === "url");
      const mTag = tags.find((t) => t[0] === "m");
      const xTag = tags.find((t) => t[0] === "x");
      const sizeTag = tags.find((t) => t[0] === "size");
      const altTag = tags.find((t) => t[0] === "alt");

      expect(urlTag).toBeDefined();
      expect(urlTag![1]).toMatch(/^http:\/\/127\.0\.0\.1:9002\/[0-9a-f]{64}$/);
      expect(mTag).toEqual(["m", "image/png"]);
      expect(xTag).toBeDefined();
      expect(xTag![1]).toMatch(/^[0-9a-f]{64}$/);
      expect(sizeTag).toEqual(["size", String(file.size)]);
      expect(altTag).toEqual(["alt", "Topology Architecture"]);

      // Verify PUT upload occurred to Blossom endpoint
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^http:\/\/127\.0\.0\.1:9002\/[0-9a-f]{64}$/),
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            "Content-Type": "image/png",
          }),
        }),
      );

      await waitFor(() => {
        expect(screen.getByText(/Media drop published to mesh/i)).toBeInTheDocument();
      });
    });
  });

  describe("Kind 30023 Civic Poll Schema & Poly Direct Ingest Webhook Parity", () => {
    it("conforms to canonical Poly schema and posts to :8002/api/nostr/ingest/", async () => {
      const onClose = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });
      globalThis.fetch = mockFetch;

      render(<QuickDispatchModal isOpen={true} onClose={onClose} />);

      // Switch to Civic Poll tab
      const pollTabBtn = screen.getByRole("button", { name: /Civic Poll \(Kind 30023\)/i });
      await act(async () => {
        fireEvent.click(pollTabBtn);
      });

      const titleInput = screen.getByPlaceholderText(/Upgrade quorum threshold/i);
      await act(async () => {
        fireEvent.change(titleInput, { target: { value: "Protocol Amendment v3.0" } });
      });

      const descInput = screen.getByPlaceholderText(/Provide background context/i);
      await act(async () => {
        fireEvent.change(descInput, { target: { value: "Detailed proposal for protocol amendments." } });
      });

      // Change fidelity selector to institutional
      const fidelitySelect = screen.getByLabelText(/Minimum Fidelity Tier/i);
      await act(async () => {
        fireEvent.change(fidelitySelect, { target: { value: "institutional" } });
      });

      const createBtn = screen.getByRole("button", { name: /Create Civic Poll/i });
      await act(async () => {
        fireEvent.click(createBtn);
      });

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("dispatch_nostr_event", expect.objectContaining({
          kind: 30023,
          content: "Detailed proposal for protocol amendments.",
          profileId: "primary",
        }));
      });

      // Verify Poly schema tags
      const invokeCall = mockInvoke.mock.calls.find(
        (c) => c[0] === "dispatch_nostr_event" && c[1]?.kind === 30023,
      );
      expect(invokeCall).toBeDefined();
      const tags: string[][] = invokeCall![1].tags;

      // ["d", uuid]
      const dTag = tags.find((t) => t[0] === "d");
      expect(dTag).toBeDefined();
      expect(dTag![1]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      // ["title", title]
      expect(tags).toContainEqual(["title", "Protocol Amendment v3.0"]);

      // ["fidelity_min", "1"|"2"|"3"] - institutional maps to "2"
      expect(tags).toContainEqual(["fidelity_min", "2"]);

      // ["option", text] (2-item format)
      expect(tags).toContainEqual(["option", "Option 1"]);
      expect(tags).toContainEqual(["option", "Option 2"]);

      // ["expires", ts]
      const expiresTag = tags.find((t) => t[0] === "expires");
      expect(expiresTag).toBeDefined();
      expect(Number(expiresTag![1])).toBeGreaterThan(Date.now() / 1000 - 10);

      // ["org", "iyou"]
      expect(tags).toContainEqual(["org", "iyou"]);

      // Verify direct ingest webhook to iyou_poly on :8002
      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8002/api/nostr/ingest/",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
          body: expect.stringContaining("e0a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f7a8b9c0d1e2f3a4b5c"),
        }),
      );

      await waitFor(() => {
        expect(screen.getByText(/Civic Poll published to mesh/i)).toBeInTheDocument();
      });
    });
  });
});
