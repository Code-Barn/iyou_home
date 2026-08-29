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

import { describe, expect, it } from "vitest";
import {
  bech32Decode,
  decodeNpubToHex,
  normalizePeerAddress,
  targetFromPeerId,
} from "../lib/chatAddress";

const HEX = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const NPUB = "npub142aueh0wluqpzg3ng32kvaugnx4thnxaamlsqyfzxdz92enh3zvsm2mwpp";

describe("bech32 decoding", () => {
  it("decodes a canonical npub to its 64-hex key", () => {
    expect(decodeNpubToHex(NPUB)).toBe(HEX);
  });

  it("accepts upper-case Bech32 (checksum is case-insensitive)", () => {
    expect(decodeNpubToHex(NPUB.toUpperCase())).toBe(HEX);
  });

  it("rejects a corrupted checksum", () => {
    const broken = `${NPUB.slice(0, -1)}q`;
    expect(decodeNpubToHex(broken)).toBe("");
  });

  it("rejects non-npub hrp payloads", () => {
    const { hrp, data } = bech32Decode(NPUB);
    expect(hrp).toBe("npub");
    void data;
  });

  it("rejects garbage bech32", () => {
    expect(decodeNpubToHex("npub1!!!!!")).toBe("");
    expect(decodeNpubToHex("notbech32atall")).toBe("");
  });
});

describe("normalizePeerAddress", () => {
  it("canonicalizes a did:key identity", () => {
    const r = normalizePeerAddress(
      "did:key:z6MkqwjSoFyuJ6mKubEGcCxGtxrfBWwXmA9jE5EFkeVHKDDa",
    );
    expect(r).toEqual({ ok: true, peerId: HEX, peerHex: HEX, peerJid: `${HEX}@127.0.0.1` });
  });

  it("canonicalizes an npub address", () => {
    expect(normalizePeerAddress(NPUB)).toEqual({
      ok: true,
      peerId: HEX,
      peerHex: HEX,
      peerJid: `${HEX}@127.0.0.1`,
    });
  });

  it("passes through a 64-hex pubkey", () => {
    expect(normalizePeerAddress(HEX.toUpperCase())).toEqual({
      ok: true,
      peerId: HEX,
      peerHex: HEX,
      peerJid: `${HEX}@127.0.0.1`,
    });
  });

  it("accepts a bare JID and detects a hex local part", () => {
    const r = normalizePeerAddress("alice@iyou.me");
    expect(r).toEqual({ ok: true, peerId: "alice@iyou.me", peerHex: "", peerJid: "alice@iyou.me" });

    const hexLocal = normalizePeerAddress(`${HEX}@127.0.0.1`);
    expect(hexLocal).toEqual({
      ok: true,
      peerId: HEX,
      peerHex: HEX,
      peerJid: `${HEX}@127.0.0.1`,
    });
  });

  it("fails closed on malformed input", () => {
    expect(normalizePeerAddress("").ok).toBe(false);
    expect(normalizePeerAddress("   ").ok).toBe(false);
    expect(normalizePeerAddress("not a key").ok).toBe(false);
    expect(normalizePeerAddress("did:key:znotthere").ok).toBe(false);
    expect(normalizePeerAddress("npub1zzzzzzzzzz").ok).toBe(false);
    expect(normalizePeerAddress("abc123").ok).toBe(false);
    expect(normalizePeerAddress("alice@").ok).toBe(false);
    expect(normalizePeerAddress("@iyou.me").ok).toBe(false);
    expect(normalizePeerAddress("alice@iyou.me/resource").ok).toBe(false);
    expect(normalizePeerAddress("a b@iyou.me").ok).toBe(false);
  });
});

describe("targetFromPeerId", () => {
  it("attaches the canonical jid and preserves a petname", () => {
    const t = targetFromPeerId(NPUB, "Alice");
    expect(t).toEqual({ peerId: HEX, peerHex: HEX, jid: `${HEX}@127.0.0.1`, displayName: "Alice" });
  });

  it("degrades gracefully for unresolvable input", () => {
    expect(targetFromPeerId("junk")).toEqual({ peerId: "junk" });
  });
});