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

// Native-enclave OMEMO session state. The raw ratchet keys live inside the
// Rust enclave; this module tracks device registries + trust, negotiates the
// envelope shape (`<encrypted xmlns="eu.siacs.conversations.omemo">`), and
// holds an explicit AES-GCM scaffold for plaintext sealing until the enclave
// ratchet handoff lands. Never confuse the scaffold with production secrecy —
// it is envelope mechanics, not key-agreement.

import { invoke } from "@tauri-apps/api/core";

export const OMEMO_ENVELOPE_NS = "eu.siacs.conversations.omemo";

export interface OmemoDeviceInfo {
  device_id: number;
  identity_public_hex: string;
  signed_prekey_public_hex: string;
  active: boolean;
}

export interface OmemoBundlePayload {
  device_id: number;
  identity_public_hex: string;
  signed_prekey_public_hex: string;
  signing_public_hex: string;
  one_time_prekeys: { id: number; public_hex: string }[];
  signature: string;
}

export type OmemoTrust = "untrusted" | "verified";

export interface ChatTranscriptEntry {
  id: string;
  direction: "out" | "in";
  body: string;
  encrypted: boolean;
  timestamp: number;
  sender: string;
}

export interface OmemoEnvelope {
  sid: number;
  keys: { rid: number; iv: string; payload: string }[];
}

export function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58ToBytes(input: string): Uint8Array {
  const raw = new Uint8Array(input.length);
  let length = 0;
  for (const char of input) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit === -1) {
      throw new Error("Invalid base58 character");
    }
    let carry = digit;
    for (let j = 0; j < length; j += 1) {
      const acc = raw[j] * 58 + carry;
      raw[j] = acc & 0xff;
      carry = acc >> 8;
    }
    while (carry > 0) {
      raw[length] = carry & 0xff;
      carry >>= 8;
      length += 1;
    }
  }
  let zeroes = 0;
  while (zeroes < input.length && input[zeroes] === "1") {
    zeroes += 1;
  }
  const out = new Uint8Array(length + zeroes);
  for (let j = 0; j < length; j += 1) {
    out[zeroes + j] = raw[length - 1 - j];
  }
  return out;
}

/**
 * Canonical 64-hex routing key for an XMPP bare JID. Accepts either a plain
 * hex key (pass-through) or a `did:key:z<multibase>` identity; returns empty
 * for anything else.
 */
export function toRoutingHex(peerId: string): string {
  const trimmed = peerId.trim();
  if (trimmed.length === 64 && /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (trimmed.startsWith("did:key:z")) {
    try {
      const bytes = base58ToBytes(trimmed.slice("did:key:z".length));
      if (bytes.length === 34 && bytes[0] === 0xed && bytes[1] === 0x01) {
        return toHex(bytes.slice(2).buffer).toLowerCase();
      }
    } catch {
      return "";
    }
  }
  return "";
}

function fromHex(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  return out;
}

function b64FromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...(bytes.subarray(i, i + 0x8000) as unknown as number[]));
  }
  return btoa(out);
}

function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export class OmemoSession {
  readonly ownJid: string;
  readonly peerJid: string;

  ownDevice: OmemoDeviceInfo | null = null;
  peerDevice: OmemoDeviceInfo | null = null;
  peerTrust: OmemoTrust = "untrusted";

  private aesKey: CryptoKey | null = null;

  constructor(ownJid: string, peerJid: string) {
    this.ownJid = ownJid;
    this.peerJid = peerJid;
  }

  /** Resolve this machine's OMEMO device from its published self-bundle. */
  async initOmemo(): Promise<void> {
    const ownBundle = await invoke<OmemoBundlePayload | null>(
      "omemo_fetch_peer_bundle",
      { peerJid: this.ownJid },
    );
    if (ownBundle) {
      this.ownDevice = {
        device_id: ownBundle.device_id,
        identity_public_hex: ownBundle.identity_public_hex,
        signed_prekey_public_hex: ownBundle.signed_prekey_public_hex,
        active: true,
      };
    }

    const peerDevices = await invoke<OmemoDeviceInfo[] | null>(
      "omemo_list_devices",
      { peerJid: this.peerJid },
    );
    const list = Array.isArray(peerDevices) ? peerDevices : [];
    this.peerDevice = list[0] ?? null;
  }

  /** Advertise (validate + persist) the enclave bundle under our own JID. */
  async publishLocalBundle(): Promise<OmemoBundlePayload | null> {
    const ok = await invoke<boolean>("omemo_publish_bundle", {
      bundleJson: "",
    });
    if (!ok) {
      return null;
    }
    const ownBundle = await invoke<OmemoBundlePayload | null>(
      "omemo_fetch_peer_bundle",
      { peerJid: this.ownJid },
    );
    if (ownBundle) {
      this.ownDevice = {
        device_id: ownBundle.device_id,
        identity_public_hex: ownBundle.identity_public_hex,
        signed_prekey_public_hex: ownBundle.signed_prekey_public_hex,
        active: true,
      };
    }
    return ownBundle;
  }

  markPeerVerified(deviceId: number): void {
    if (this.peerDevice?.device_id === deviceId) {
      this.peerTrust = "verified";
    }
  }

  // -- AES-GCM scaffold (placeholder until the enclave ratchet handoff) --

  private async ensureScaffoldKey(): Promise<CryptoKey> {
    if (this.aesKey) {
      return this.aesKey;
    }
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey(
      "raw",
      seed,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    this.aesKey = key;
    return key;
  }

  async encryptText(text: string): Promise<string> {
    const key = await this.ensureScaffoldKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(text),
    );
    return `${b64FromBytes(iv)}.${b64FromBytes(new Uint8Array(ciphertext))}`;
  }

  async decryptText(sealed: string): Promise<string> {
    const key = await this.ensureScaffoldKey();
    const [ivB64, payloadB64] = sealed.split(".");
    if (!ivB64 || !payloadB64) {
      throw new Error("Malformed sealed payload");
    }
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesFromB64(ivB64) },
      key,
      bytesFromB64(payloadB64) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  }

  // -- Envelope geometry --

  /** Build `<encrypted>` inner content for the current peer device. */
  buildEnvelope(payloadB64: string): string {
    const sid = this.ownDevice?.device_id ?? 0;
    const rid = this.peerDevice?.device_id ?? 0;
    return `<header sid="${sid}"><key rid="${rid}">${payloadB64}</key></header><payload>${payloadB64}</payload>`;
  }

  /** Parse `<encrypted>` inner content back into its structural parts. */
  static parseEnvelope(xml: string): OmemoEnvelope {
    const doc = new DOMParser().parseFromString(`<encrypted xmlns="${OMEMO_ENVELOPE_NS}">${xml}</encrypted>`, "text/xml");
    const header = doc.querySelector("header");
    const sid = Number(header?.getAttribute("sid") ?? 0);
    const key = doc.querySelector("key");
    const rid = Number(key?.getAttribute("rid") ?? 0);
    const payload = doc.querySelector("payload")?.textContent ?? "";
    const iv = key?.getAttribute("iv") ?? "";
    return { sid, keys: [{ rid, iv, payload }] };
  }

  /** Strip a full JID down to its bare `{local}@{domain}` routing key. */
  static parseBare(jid: string): string {
    return jid.split("/")[0] ?? "";
  }

  /** Human-friendly fingerprint for the trust modal. */
  fingerprint(device: OmemoDeviceInfo | null): string {
    const hexKey = device?.identity_public_hex ?? "";
    if (hexKey.length < 20) return "unknown";
    const groups: string[] = [];
    for (let i = 0; i < hexKey.length; i += 8) {
      groups.push(hexKey.slice(i, i + 8));
    }
    return groups.slice(0, 8).join(" ");
  }

  static shortDeviceId(deviceId: number): string {
    return toHex(new TextEncoder().encode(String(deviceId)));
  }

  static truncateFingerprint(hexKey: string, length = 32): string {
    return hexKey.length <= length ? hexKey : `${hexKey.slice(0, length)}…`;
  }

  // Keep fromHex referenced for future identity-key usage.
  static deviceIdKey(deviceId: number): Uint8Array {
    return fromHex(OmemoSession.shortDeviceId(deviceId));
  }
}