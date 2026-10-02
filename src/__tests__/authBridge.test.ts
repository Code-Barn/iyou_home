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

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkAndBootstrapSponsor, DEFAULT_IDP_BASE_URL } from "../lib/authBridge";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("checkAndBootstrapSponsor", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches the airlock sponsor endpoint and invokes bootstrap_sponsor_contact when sponsor_did is present", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        sponsor_did: "did:key:z6MksponsorTest123456",
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await checkAndBootstrapSponsor("https://iyou.me/");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("https://iyou.me/auth/airlock/sponsor/", {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("bootstrap_sponsor_contact", {
      sponsorDid: "did:key:z6MksponsorTest123456",
      label: "Community Sponsor",
    });
    expect(result).toBe("did:key:z6MksponsorTest123456");
  });

  it("uses DEFAULT_IDP_BASE_URL when no URL is passed", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        sponsor_did: "did:key:z6MkDefaultSponsor",
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await checkAndBootstrapSponsor();

    expect(mockFetch).toHaveBeenCalledWith(`${DEFAULT_IDP_BASE_URL}/auth/airlock/sponsor/`, expect.any(Object));
    expect(mockInvoke).toHaveBeenCalledWith("bootstrap_sponsor_contact", {
      sponsorDid: "did:key:z6MkDefaultSponsor",
      label: "Community Sponsor",
    });
    expect(result).toBe("did:key:z6MkDefaultSponsor");
  });

  it("does not invoke bootstrap_sponsor_contact when sponsor_did is null or empty", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        sponsor_did: null,
      }),
    });
    globalThis.fetch = mockFetch;

    const result = await checkAndBootstrapSponsor("https://iyou.me");
    expect(mockFetch).toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("silently catches and ignores 401/404 HTTP errors", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: vi.fn().mockResolvedValue({ error: "Not found" }),
    });
    globalThis.fetch = mockFetch;

    const result = await checkAndBootstrapSponsor("https://iyou.me");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("silently catches and ignores network failures / offline environments", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("NetworkError: Failed to fetch"));
    globalThis.fetch = mockFetch;

    const result = await checkAndBootstrapSponsor("https://iyou.me");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
