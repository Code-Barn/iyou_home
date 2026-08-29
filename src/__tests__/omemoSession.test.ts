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
import { OmemoSession, toRoutingHex } from "../lib/omemoSession";
import { XmppClient } from "../lib/xmppClient";

describe("toRoutingHex", () => {
  it("passes through a canonical 64-hex key (lowercased)", () => {
    const hex = "DEADBEEF".repeat(8); // 64 hex chars
    expect(toRoutingHex("  " + hex + "  ")).toBe(hex.toLowerCase());
  });

  it("rejects non-hex lengths", () => {
    expect(toRoutingHex("not a key")).toBe("");
    expect(toRoutingHex("abc123")).toBe("");
    expect(toRoutingHex("DEADBEEF".repeat(8) + "0")).toBe("");
  });

  it("extracts the 32-byte key from a did:key multibase identity", () => {
    const did =
      "did:key:z6MkqwjSoFyuJ6mKubEGcCxGtxrfBWwXmA9jE5EFkeVHKDDa";
    expect(toRoutingHex(did)).toBe(
      "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    );
  });

  it("returns empty for unrecognized shapes", () => {
    expect(toRoutingHex("did:ethr:0x1234")).toBe("");
    expect(toRoutingHex("https://example.com")).toBe("");
  });
});

describe("OmemoSession JID helpers", () => {
  it("parses bare JIDs from full addresses", () => {
    expect(
      OmemoSession.parseBare("deadbeef@127.0.0.1/sovereign-abc"),
    ).toBe("deadbeef@127.0.0.1");
    expect(OmemoSession.parseBare("deadbeef@127.0.0.1")).toBe(
      "deadbeef@127.0.0.1",
    );
    expect(OmemoSession.parseBare("")).toBe("");
  });

  it("parses an OMEMO envelope into header/key/payload parts", () => {
    const envelope = OmemoSession.parseEnvelope(
      '<header sid="42"><key rid="7" iv="iv0000">sealed</key></header><payload>sealed</payload>',
    );
    expect(envelope.sid).toBe(42);
    expect(envelope.keys[0]?.rid).toBe(7);
    expect(envelope.keys[0]?.payload).toBe("sealed");
    expect(envelope.keys[0]?.iv).toBe("iv0000");
  });

  it("marks a peer device verified by id", async () => {
    const session = new OmemoSession(
      "local@127.0.0.1",
      "peer@127.0.0.1",
    );
    session.peerDevice = {
      device_id: 9,
      identity_public_hex: "a".repeat(64),
      signed_prekey_public_hex: "b".repeat(64),
      active: true,
    };
    expect(session.peerTrust).toBe("untrusted");
    session.markPeerVerified(9);
    expect(session.peerTrust).toBe("verified");
    session.markPeerVerified(999);
    expect(session.peerTrust).toBe("verified");
  });

  it("formats groupable fingerprints", () => {
    const session = new OmemoSession("l@127.0.0.1", "p@127.0.0.1");
    const fp = session.fingerprint({
      device_id: 1,
      identity_public_hex: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      signed_prekey_public_hex: "ff".repeat(32),
      active: true,
    });
    expect(fp.split(" ").length).toBeGreaterThanOrEqual(4);
  });
});

describe("XmppClient", () => {
  it("exposes a bound JID from credentials + resource", () => {
    const pubkey = "deadbeef".repeat(8); // 64 hex chars
    const client = new XmppClient();
    client.setup({
      jid: `${pubkey}@127.0.0.1`,
      pubkey_hex: pubkey,
      wss_url: "wss://home.iyou.me:5222",
    });
    // setup must not bind a resource yet.
    expect(client.jid).toBe(`${pubkey}@127.0.0.1`);
    client.disconnect();
    expect(client.jid).toBe(`${pubkey}@127.0.0.1`);
    expect(client.isConnected).toBe(false);
  });
});