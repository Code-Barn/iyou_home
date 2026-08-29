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

// RFC 7395 XMPP-over-WebSocket client against the native enclave prosody
// endpoint. Authenticates with SASL PLAIN using the Level 1 persona DID as
// username and its hex Ed25519 public key as password (mutually verified
// server-side via extract_hex_from_did), then binds a resource and routes
// bare-JID addressed `<message>` stanzas.

export interface ChatSessionCredentials {
  jid: string;
  pubkey_hex: string;
  wss_url: string;
}

export interface ChatInbound {
  from: string;
  to: string;
  body: string;
  omemo?: string;
  raw: string;
}

export type ChatStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "binding"
  | "ready"
  | "closed"
  | "error";

const XMPP_FRAMING_NS = "urn:ietf:params:xml:ns:xmpp-framing";
const SASL_NS = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND_NS = "urn:ietf:params:xml:ns:xmpp-bind";
const XMPP_SUBPROTOCOL = "xmpp";

function base64EncodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...(bytes.subarray(i, i + 0x8000) as unknown as number[]));
  }
  return btoa(out);
}

function parseMessageStanza(stanzaText: string): ChatInbound | null {
  if (!stanzaText.includes("<message")) {
    return null;
  }
  const doc = new DOMParser().parseFromString(stanzaText, "text/xml");
  const messageEl = doc.querySelector("message");
  if (!messageEl) {
    return null;
  }
  const from = messageEl.getAttribute("from") ?? "";
  const to = messageEl.getAttribute("to") ?? "";
  const bodyEl = messageEl.querySelector("body");
  const omemoEl = messageEl.querySelector("encrypted");
  return {
    from,
    to,
    body: bodyEl?.textContent ?? "",
    omemo: omemoEl?.textContent ?? undefined,
    raw: stanzaText,
  };
}

export class XmppClient {
  private ws: WebSocket | null = null;
  private credentials: ChatSessionCredentials | null = null;
  private boundResource = "";
  private saslCompleted = false;
  private accumulator = "";

  private statusCallback: ((status: ChatStatus) => void) | null = null;
  private messageCallback: ((inbound: ChatInbound) => void) | null = null;
  private errorCallback: ((message: string) => void) | null = null;

  onStatus(cb: (status: ChatStatus) => void): void {
    this.statusCallback = cb;
  }

  onMessage(cb: (inbound: ChatInbound) => void): void {
    this.messageCallback = cb;
  }

  onError(cb: (message: string) => void): void {
    this.errorCallback = cb;
  }

  get isConnected(): boolean {
    return (
      this.ws?.readyState === WebSocket.OPEN && this.boundResource.length > 0
    );
  }

  get jid(): string {
    const creds = this.credentials;
    if (!creds) return "";
    const local = creds.pubkey_hex.toLowerCase();
    return this.boundResource
      ? `${local}@127.0.0.1/${this.boundResource}`
      : `${local}@127.0.0.1`;
  }

  setup(creds: ChatSessionCredentials): void {
    this.credentials = creds;
    this.boundResource = "";
    this.saslCompleted = false;
    this.accumulator = "";
  }

  connect(): void {
    if (!this.credentials) {
      this.emitStatus("error");
      this.emitError("No chat session credentials — call setup() first.");
      return;
    }
    this.emitStatus("connecting");
    const socket = new WebSocket(this.credentials.wss_url, [XMPP_SUBPROTOCOL]);
    this.ws = socket;
    socket.onopen = () => this.sendOpenFrame();
    socket.onmessage = (event) => this.handleIncoming(String(event.data));
    socket.onclose = () => {
      this.ws = null;
      this.emitStatus("closed");
    };
    socket.onerror = () => {
      this.emitError("WebSocket connection to the enclave prosody failed.");
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.saslCompleted = false;
    this.boundResource = "";
    this.emitStatus("closed");
  }

  sendMessage(to: string, body: string): void {
    const stanza = `<message type="chat" from="${xmlEscape(this.jid)}" to="${xmlEscape(
      to,
    )}"><body>${xmlEscape(body)}</body></message>`;
    this.sendText(stanza);
  }

  sendOmemoStanza(to: string, encryptedXml: string): void {
    const stanza = `<message type="chat" from="${xmlEscape(this.jid)}" to="${xmlEscape(
      to,
    )}"><encrypted xmlns="eu.siacs.conversations.omemo">${encryptedXml}</encrypted></message>`;
    this.sendText(stanza);
  }

  // -- internals --

  private sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emitError("Cannot send while the enclave socket is closed.");
      return;
    }
    this.ws.send(text);
  }

  private sendOpenFrame(): void {
    this.sendText(
      `<open xmlns="${XMPP_FRAMING_NS}" to="127.0.0.1" version="1.0" xml:lang="en"/>`,
    );
  }

  private handleIncoming(data: string): void {
    // RFC 7395 delivers one complete XML element per frame.
    this.accumulator += data;

    if (/<open[\u0020/]/.test(data)) {
      this.handleServerOpen();
      return;
    }
    if (/<success[\u0020/]/.test(data)) {
      this.saslCompleted = true;
      this.emitStatus("authenticating");
      // SASL success -> restart the stream, then bind.
      this.sendOpenFrame();
      return;
    }
    if (data.includes("<challenge") || /<failure[\u0020/]/.test(data)) {
      this.emitStatus("error");
      this.emitError("SASL authentication was rejected by the enclave.");
      this.disconnect();
      return;
    }

    const buffer = this.accumulator;
    this.accumulator = "";

    // The bind result `<iq>` confirms the full bound JID and marks us ready.
    if (buffer.includes("urn:ietf:params:xml:ns:xmpp-bind")) {
      this.syncBoundFromServer(buffer);
      this.emitStatus("ready");
    }

    const inbound = parseMessageStanza(buffer);
    if (inbound && (inbound.body || inbound.omemo)) {
      this.messageCallback?.(inbound);
    }
  }

  private handleServerOpen(): void {
    const creds = this.credentials;
    if (!creds) {
      return;
    }
    if (!this.saslCompleted) {
      this.emitStatus("authenticating");
      const payload = `\u0000${creds.jid}\u0000${creds.pubkey_hex}`;
      this.sendText(
        `<auth xmlns="${SASL_NS}" mechanism="PLAIN">${base64EncodeText(payload)}</auth>`,
      );
      return;
    }
    if (!this.boundResource) {
      this.emitStatus("binding");
      const resource = `sovereign-${Date.now().toString(16)}`;
      this.boundResource = resource;
      this.sendText(
        `<iq type="set" id="sovereign-bind-1"><bind xmlns="${BIND_NS}"><resource>${resource}</resource></bind></iq>`,
      );
    }
  }

  /** Adopt the full bound JID `<jid>` value echoed by the server response. */
  private syncBoundFromServer(buffer: string): void {
    const match = buffer.match(/<jid>([^<]+)<\/jid>/);
    if (match?.[1]) {
      this.boundResource = match[1].split("/").slice(1).join("/") || this.boundResource;
    }
  }

  private emitStatus(status: ChatStatus): void {
    this.statusCallback?.(status);
  }

  private emitError(message: string): void {
    this.errorCallback?.(message);
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}