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
import FamilyEnclave from "../components/family/FamilyEnclave";
import { capabilityTag } from "../lib/types";
import type { ChildPodEntry, GrantCapability } from "../lib/types";

type InvokeHandler = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type InvokeArgs = Record<string, unknown>;

const { mockInvoke, state } = vi.hoisted(() => {
  const state = {
    pods: [] as unknown[],
    calls: [] as { cmd: string; args?: InvokeArgs }[],
  };

  const handler: InvokeHandler = (cmd, args) => {
    state.calls.push({ cmd, args });
    switch (cmd) {
      case "list_child_pods":
        return Promise.resolve(state.pods);
      case "generate_pod_escrow_shares":
        return Promise.resolve({
          pod_id: "pod_ceremony1",
          child_did: "did:key:z6Mkceremonychild",
          child_nostr_pubkey_hex: "ab".repeat(32),
          parent_share_b64: "cGFyZW50LXNoYXJlLWhleA==",
          satellite_payload_b64: "c2F0ZWxsaXRlLXNoYXJlLXBheWxvYWQ=",
          sheet_payload_b64: "Y29sZC1zaGVldC1zaGFyZS1wYXlsb2Fk",
          unlock_at: 1_760_000_000,
        });
      case "bind_child_pod":
        return Promise.resolve(state.pods[0]);
      case "emancipate_child_pod":
        return Promise.resolve();
      case "create_supervisory_grant":
        return Promise.resolve({
          v: 1,
          issuer_did: "did:key:z6Mkparent",
          subject_did: "did:key:z6Mkceremonychild",
          pod_id: "pod_ceremony1",
          nonce: "deadbeef",
          capabilities: [
            { scope: "relay", effect: "deny", relay_id: null, boundary: null, threshold: null },
          ],
          valid_from: 1_700_000_000,
          expires_at: 1_700_000_000 + 2_592_000,
          revocable: true,
          signature: "00".repeat(64),
        });
      default:
        return Promise.resolve();
    }
  };

  return { mockInvoke: vi.fn<InvokeHandler>(handler), state };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const podFixture = (over: Partial<ChildPodEntry> = {}): ChildPodEntry => ({
  pod_id: "pod_a1b2c3",
  child_did: "did:key:z6MkpodOne",
  child_nostr_pubkey_hex: "ab".repeat(32),
  child_device_id: "Ari\u2019s iPad",
  bound_at: 1_700_000_000,
  custody_stage: 1,
  active_grants: ["9114:abc123"],
  escrow_ref: "escrow_store.json#pod_a1b2c3",
  emancipated_at: null,
  ...over,
});

describe("FamilyEnclave (RFC-005)", () => {
  beforeEach(() => {
    state.pods = [];
    state.calls = [];
    mockInvoke.mockClear();
  });

  test("renders empty state when no child pods are bound", async () => {
    render(<FamilyEnclave />);
    await waitFor(() => {
      expect(screen.getByTestId("family-empty")).toBeTruthy();
    });
    expect(screen.getByText(/Bind Dependent Device/)).toBeTruthy();
  });

  test("lists bound pods with custody status pills and grant tags", async () => {
    state.pods = [
      podFixture({ custody_stage: 1 }),
      podFixture({
        pod_id: "pod_teen1",
        child_did: "did:key:z6Mkteen",
        child_device_id: "Nico\u2019s Pixel",
        custody_stage: 2,
        active_grants: [],
      }),
      podFixture({
        pod_id: "pod_free1",
        child_did: "did:key:z6Mkfree",
        child_device_id: "\u201CGrown\u201D Laptop",
        custody_stage: 3,
        emancipated_at: 1_750_000_000,
        active_grants: [],
      }),
    ];

    render(<FamilyEnclave />);

    const supervised = await screen.findByTestId("family-pod-stage-pod_a1b2c3");
    expect(supervised.textContent).toBe("Supervised");
    expect(screen.getByTestId("family-pod-grant-pod_a1b2c3").textContent).toContain("9114");

    const teen = screen.getByTestId("family-pod-stage-pod_teen1");
    expect(teen.textContent).toBe("Teen");
    expect(screen.getByTestId("family-pod-nogrants-pod_teen1").textContent).toContain("No active");

    const free = screen.getByTestId("family-pod-stage-pod_free1");
    expect(free.textContent).toBe("Emancipated");
    // Emancipated pods must not offer another emancipation.
    expect(screen.queryByTestId("family-emancipate-pod_free1")).toBeNull();
  });

  test("binding flow generates 3 escrow shares and binds with ceremony identity", async () => {
    render(<FamilyEnclave />);

    fireEvent.click(screen.getByTestId("family-open-bind"));
    expect(screen.getByTestId("pod-binding-modal")).toBeTruthy();

    // Generate button disabled until an alias is entered.
    const generateBtn = screen.getByTestId("pod-generate") as HTMLButtonElement;
    expect(generateBtn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("pod-device-alias"), {
      target: { value: "Ari\u2019s iPad" },
    });
    expect((screen.getByTestId("pod-generate") as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("pod-generate"));

    await waitFor(() => {
      expect(screen.getByTestId("pod-binding-success")).toBeTruthy();
    });

    // Share 1 auto-saved note, share 2 + share 3 presented.
    expect(screen.getByText(/escrow_store\.json/)).toBeTruthy();
    expect(screen.getByTestId("pod-satellite-payload").textContent).toBe(
      "c2F0ZWxsaXRlLXNoYXJlLXBheWxvYWQ=",
    );
    expect(screen.getByTestId("pod-sheet-payload").textContent).toBe(
      "Y29sZC1zaGVldC1zaGFyZS1wYXlsb2Fk",
    );

    // The ceremony ran, then the pod was bound with the ceremony identity.
    const ceremonyCall = state.calls.find((c) => c.cmd === "generate_pod_escrow_shares");
    expect(ceremonyCall).toBeTruthy();
    expect((ceremonyCall!.args as InvokeArgs).custodyStage).toBe(1);
    expect(String((ceremonyCall!.args as InvokeArgs).podId).startsWith("pod_")).toBe(true);

    const bindCall = state.calls.find((c) => c.cmd === "bind_child_pod");
    expect(bindCall).toBeTruthy();
    expect((bindCall!.args as InvokeArgs).childDid).toBe("did:key:z6Mkceremonychild");
    expect((bindCall!.args as InvokeArgs).childDeviceId).toBe("Ari\u2019s iPad");

    fireEvent.click(screen.getByTestId("pod-finish"));
    await waitFor(() => {
      expect(screen.queryByTestId("pod-binding-modal")).toBeNull();
    });
  });

  test("binding rejects a child DID override that does not match the ceremony", async () => {
    render(<FamilyEnclave />);
    fireEvent.click(screen.getByTestId("family-open-bind"));

    fireEvent.change(screen.getByTestId("pod-device-alias"), {
      target: { value: "Some iPad" },
    });
    fireEvent.change(screen.getByTestId("pod-child-did"), {
      target: { value: "did:key:z6Mkforeigndentity" },
    });
    fireEvent.click(screen.getByTestId("pod-generate"));

    await waitFor(() => {
      expect(screen.getByTestId("pod-binding-error").textContent).toContain(
        "ceremony identity mismatch",
      );
    });
    expect(state.calls.some((c) => c.cmd === "bind_child_pod")).toBe(false);
  });

  test("emancipation requires a two-step confirm and revokes to empty grants", async () => {
    state.pods = [podFixture({ custody_stage: 2 })];
    render(<FamilyEnclave />);

    const btn = await screen.findByTestId("family-emancipate-pod_a1b2c3");
    fireEvent.click(btn);
    // Armed: label flips to the confirm prompt; no IPC yet.
    expect(btn.textContent).toContain("Confirm Emancipation");
    expect(state.calls.some((c) => c.cmd === "emancipate_child_pod")).toBe(false);

    fireEvent.click(btn);
    await waitFor(() => {
      expect(state.calls.some((c) => c.cmd === "emancipate_child_pod")).toBe(true);
    });
    const emCall = state.calls.find((c) => c.cmd === "emancipate_child_pod");
    expect((emCall!.args as InvokeArgs).podId).toBe("pod_a1b2c3");
  });

  test("capability tags render the canonical RFC-005 labels", () => {
    const relayDeny: GrantCapability = {
      scope: "relay",
      effect: "deny",
      relay_id: null,
      boundary: null,
      threshold: null,
    };
    const coSign: GrantCapability = {
      scope: "contact_approval",
      effect: "co_sign_required",
      relay_id: null,
      boundary: null,
      threshold: 2,
    };
    const platform: GrantCapability = {
      scope: "platform_boundary",
      effect: "enforce",
      relay_id: null,
      boundary: "restricted_feed_indexing",
      threshold: null,
    };
    expect(capabilityTag(relayDeny)).toBe("Safe Relays Only");
    expect(capabilityTag(coSign)).toBe("Co-Sign Required");
    expect(capabilityTag(platform)).toBe("Enforce Platform Rules");
  });
});