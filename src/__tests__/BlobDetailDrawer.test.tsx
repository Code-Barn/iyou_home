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

import { render, screen, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import BlobDetailDrawer from "../components/blossom/BlobDetailDrawer";
import type { LocalBlobInfo } from "../components/blossom/BlobGrid";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(true),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

const makeBlob = (overrides: Partial<LocalBlobInfo> = {}): LocalBlobInfo => ({
  sha256: "a".repeat(64),
  mime_type: "image/png",
  size_bytes: 1024,
  created_at: Math.floor(Date.now() / 1000),
  ...overrides,
});

describe("BlobDetailDrawer", () => {
  it("shows the close button and calls onClose when clicked", async () => {
    const onClose = vi.fn();
    render(
      <BlobDetailDrawer
        blob={makeBlob()}
        onClose={onClose}
        onDeleted={vi.fn()}
      />,
    );

    const btn = screen.getByRole("button", { name: /close/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      <BlobDetailDrawer
        blob={makeBlob()}
        onClose={onClose}
        onDeleted={vi.fn()}
      />,
    );

    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
