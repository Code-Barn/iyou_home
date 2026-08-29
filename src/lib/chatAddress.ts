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

// Fail-closed peer address normalization for the Messages inbox. Accepts a
// `did:key:z…` Ed25519 identity, an `npub1…` Bech32 Nostr pubkey, a 64-char
// hex Nostr pubkey, or a bare XMPP JID, and canonicalizes it into a routing
// `{hex}@127.0.0.1` bare JID. Malformed input produces an `{ ok: false }`
// result with a human-readable error — never a guessed / partial address.

import { toRoutingHex, toHex } from "./omemoSession";
import type { ChatPeerTarget } from "./types";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export const XMPP_DOMAIN = "127.0.0.1";

const hexRegex = /^[0-9a-fA-F]{64}$/;
const bareJidRegex = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/;

export type PeerAddressResult =
  | { ok: true; peerId: string; peerHex: string; peerJid: string }
  | { ok: false; error: string };

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) {
      if ((b >> i) & 1) {
        chk ^= BECH32_GENERATORS[i];
      }
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) {
    out.push(hrp.charCodeAt(i) >> 5);
  }
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) {
    out.push(hrp.charCodeAt(i) & 31);
  }
  return out;
}

/** Convert 5-bit Bech32 data groups back to base-256 bytes (BIP-173). */
export function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad = false,
): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxValue = (1 << toBits) - 1;
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits) {
      throw new Error("Invalid data group");
    }
    acc = ((acc << fromBits) | value) & maxAcc;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits) {
      out.push((acc << (toBits - bits)) & maxValue);
    }
    return out;
  }
  // Unpadded conversion tolerates zero padding in the trailing group.
  if (bits >= fromBits || ((acc << (toBits - bits)) & maxValue) !== 0) {
    throw new Error("Incomplete group for unpadded conversion");
  }
  return out;
}

/** Decode a Bech32 string, validating its checksum. */
export function bech32Decode(input: string): { hrp: string; data: number[] } {
  const lower = input.toLowerCase();
  const split = lower.lastIndexOf("1");
  if (split < 1 || split + 7 > lower.length) {
    throw new Error("Invalid Bech32 length");
  }
  const hrp = lower.slice(0, split);
  const dataPart = lower.slice(split + 1);
  const data: number[] = [];
  for (const char of dataPart) {
    const digit = BECH32_CHARSET.indexOf(char);
    if (digit === -1) {
      throw new Error("Invalid Bech32 character");
    }
    data.push(digit);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) {
    throw new Error("Invalid Bech32 checksum");
  }
  return { hrp, data: data.slice(0, -6) };
}

/** Decode an `npub1…` Bech32 Nostr public key to its 64-hex form, or "" if invalid. */
export function decodeNpubToHex(input: string): string {
  let decoded: { hrp: string; data: number[] };
  try {
    decoded = bech32Decode(input.trim());
  } catch {
    return "";
  }
  if (decoded.hrp !== "npub") {
    return "";
  }
  try {
    const bytes = convertBits(decoded.data, 5, 8);
    if (bytes.length !== 32) {
      return "";
    }
    return toHex(Uint8Array.from(bytes).buffer);
  } catch {
    return "";
  }
}

/**
 * Canonicalize any accepted peer identifier into a routing bare JID. Fails
 * closed: unrecognized or malformed values never yield a partial address.
 */
export function normalizePeerAddress(input: string): PeerAddressResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter a peer identifier to start a chat." };
  }
  if (trimmed.startsWith("did:key:")) {
    const hex = toRoutingHex(trimmed);
    if (!hex) {
      return {
        ok: false,
        error: "Invalid did:key — expected an Ed25519 key (multicodec 0xed01).",
      };
    }
    return { ok: true, peerId: hex, peerHex: hex, peerJid: `${hex}@${XMPP_DOMAIN}` };
  }
  if (trimmed.startsWith("npub1") || trimmed.startsWith("NPUB1")) {
    const hex = decodeNpubToHex(trimmed);
    if (!hex) {
      return { ok: false, error: "Invalid npub address — checksum or payload rejected." };
    }
    return { ok: true, peerId: hex, peerHex: hex, peerJid: `${hex}@${XMPP_DOMAIN}` };
  }
  if (hexRegex.test(trimmed)) {
    const hex = trimmed.toLowerCase();
    return { ok: true, peerId: hex, peerHex: hex, peerJid: `${hex}@${XMPP_DOMAIN}` };
  }
  if (bareJidRegex.test(trimmed)) {
    const at = trimmed.indexOf("@");
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1).toLowerCase();
    const peerHex = hexRegex.test(local) ? local.toLowerCase() : "";
    return {
      ok: true,
      peerId: peerHex || `${local}@${domain}`,
      peerHex,
      peerJid: `${local}@${domain}`,
    };
  }
  return {
    ok: false,
    error:
      "Unrecognized identifier. Use a did:key, npub1…, 64-char hex key, or bare JID like alice@iyou.me.",
  };
}

/** Freeze a canonical ChatPeerTarget for a new or in-flight conversation. */
export function targetFromPeerId(peerId: string, displayName?: string): ChatPeerTarget {
  const result = normalizePeerAddress(peerId);
  if (!result.ok) {
    return { peerId };
  }
  return {
    peerId: result.peerId,
    peerHex: result.peerHex,
    jid: result.peerJid,
    displayName,
  };
}

/** Compact human-readable fallback for unidentified peers (e.g. `…aabb…8899`). */
export function prettyShortId(peerId: string, lead = 8, tail = 6): string {
  const value = peerId.startsWith("did:key:") ? peerId.slice("did:key:z".length) : peerId;
  if (value.length <= lead + tail + 4) {
    return peerId;
  }
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}