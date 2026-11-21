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
import { describe, it, expect, vi, beforeEach } from "vitest";
import PairQrModal from "../components/pairing/PairQrModal";

const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

describe("PairQrModal (Dual-Mode Mobile Device Pairing)", () => {
  const sampleFrame = {
    frame_id: "test-frame-uuid-999",
    verification_code: "4K7X2M",
    qr_png_b64: "data:image/png;base64,mockpngframe1",
    expires_at: Math.floor(Date.now() / 1000) + 300,
  };

  const sampleOfflineResponse = {
    envelope: {
      frame_id: "test-frame-uuid-999",
      device_did: "did:key:z6MkuSmashiPhone",
      iv_b64: "dGVzdC1pdi05OTk=",
      ciphertext_b64: "c2VhbGVkLWNpcGhlcnRleHQ=",
    },
    sealed_qr_png_b64: "data:image/png;base64,mocksealedstep3",
    sealed_uri: "iyouhome://pair-sealed?frame_id=test-frame-uuid-999&did=did%3Akey%3Az6MkuSmashiPhone&iv=dGVzdC1pdi05OTk%3D&ct=c2VhbGVkLWNpcGhlcnRleHQ%3D&ver=1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListen.mockResolvedValue(vi.fn());
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pair_begin") {
        return Promise.resolve(sampleFrame);
      }
      if (cmd === "pair_cancel") {
        return Promise.resolve();
      }
      if (cmd === "pair_process_offline_response") {
        return Promise.resolve(sampleOfflineResponse);
      }
      return Promise.resolve(null);
    });
  });

  it("renders Frame 1 QR code, verification code, and relay status indicator", async () => {
    render(<PairQrModal open={true} onClose={() => {}} onPaired={() => {}} />);

    expect(screen.getByText(/Pair Mobile Device/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("pair_begin");
    });

    expect(await screen.findByText("4K7X2M")).toBeInTheDocument();
    expect(screen.getByText("test-frame-uuid-999")).toBeInTheDocument();
    expect(screen.getByAltText("Pairing QR code")).toHaveAttribute("src", "data:image/png;base64,mockpngframe1");
    expect(screen.getByText(/Complete Offline \/ Air-Gapped Pairing/i)).toBeInTheDocument();
  });

  it("invokes pair_cancel with frameId when the user closes the modal", async () => {
    const onClose = vi.fn();
    render(<PairQrModal open={true} onClose={onClose} onPaired={() => {}} />);

    expect(await screen.findByText("4K7X2M")).toBeInTheDocument();

    const closeBtn = screen.getByRole("button", { name: /^Close$/i });
    fireEvent.click(closeBtn);

    expect(mockInvoke).toHaveBeenCalledWith("pair_cancel", { frameId: "test-frame-uuid-999" });
    expect(onClose).toHaveBeenCalled();
  });

  it("processes offline response input, invokes pair_process_offline_response, and renders Step 3 sealed QR", async () => {
    const onPaired = vi.fn();
    render(<PairQrModal open={true} onClose={() => {}} onPaired={onPaired} />);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("pair_begin");
    });

    // Expand details
    const summary = screen.getByText(/Complete Offline \/ Air-Gapped Pairing/i);
    fireEvent.click(summary);

    const textarea = screen.getByPlaceholderText(/iyouhome:\/\/pair-ack/i);
    fireEvent.change(textarea, {
      target: {
        value: "iyouhome://pair-ack?frame_id=test-frame-uuid-999&x25519=deadbeef&did=did:key:z6MkuSmashiPhone&name=iPhone&code=4K7X2M",
      },
    });

    const processBtn = screen.getByRole("button", { name: /Process Response & Seal Seed/i });
    fireEvent.click(processBtn);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("pair_process_offline_response", {
        responseUriOrJson: "iyouhome://pair-ack?frame_id=test-frame-uuid-999&x25519=deadbeef&did=did:key:z6MkuSmashiPhone&name=iPhone&code=4K7X2M",
      });
    });

    expect(await screen.findByText(/Seed Envelope Sealed Successfully/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 3:/i)).toBeInTheDocument();
    expect(screen.getByAltText("Sealed seed QR code")).toHaveAttribute("src", "data:image/png;base64,mocksealedstep3");
    expect(onPaired).toHaveBeenCalled();
  });
});
