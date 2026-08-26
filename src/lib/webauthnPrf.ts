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

/**
 * Browser-side WebAuthn PRF (pseudo-random function) interface.
 *
 * Derives a stable 32-byte local seed ("PRF KEK") from the platform
 * authenticator (Touch ID / Windows Hello / roaming passkeys) using the
 * WebAuthn `prf` extension. The seed never leaves this module except as an
 * explicit argument to Tauri IPC commands; it must never be persisted in
 * JS state, localStorage, or the DOM.
 */

export const DEFAULT_PRF_SALT = "omni-social-protocol-v1-seed-salt";

const PRF_ASSERTION_TIMEOUT_MS = 60000;

/** Minimal structural typings for the WebAuthn PRF extension (not yet in TS DOM lib). */
interface PrfExtensionInputs {
  prf?: {
    eval?: { first: BufferSource; second?: BufferSource };
    evalResults?: { first?: boolean; second?: boolean };
    create?: Record<string, never>;
  };
}

interface PrfExtensionResults {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer; second?: ArrayBuffer };
  };
}

export interface PrfSeedResult {
  /** 64-character lowercase hex encoding of the 32-byte PRF output. */
  prfSeedHex: string;
  /** Base64URL credential id of the discoverable credential used. */
  credentialId: string;
  /** True if a new resident credential was registered during this call. */
  registered: boolean;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length !== 32) {
    throw new Error(
      `WebAuthn PRF returned ${bytes.length} bytes; expected exactly 32 bytes.`,
    );
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBuffer(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function saltToBuffer(saltString: string): Uint8Array {
  return new TextEncoder().encode(saltString);
}

export function webauthnPrfSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof navigator !== "undefined" &&
    !!navigator.credentials &&
    typeof navigator.credentials.get === "function" &&
    typeof navigator.credentials.create === "function" &&
    typeof window.PublicKeyCredential === "function"
  );
}

function assertPrfResult(credential: PublicKeyCredential): ArrayBuffer {
  const results = credential.getClientExtensionResults() as PrfExtensionResults;
  const first = results.prf?.results?.first;
  if (!(first instanceof ArrayBuffer)) {
    throw new Error(
      "This browser or platform authenticator did not return a WebAuthn PRF result. " +
        "PRF biometric key derivation requires Safari 18+ (iOS/macOS), Chrome 128+, Edge 128+, " +
        "or a security key with PRF support, with iCloud Keychain / Windows Hello enabled.",
    );
  }
  return first;
}

async function assertPrfSeed(salt: Uint8Array): Promise<PrfSeedResult> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      timeout: PRF_ASSERTION_TIMEOUT_MS,
      userVerification: "required",
      extensions: {
        prf: { eval: { first: salt } },
      } as AuthenticationExtensionsClientInputs & PrfExtensionInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) {
    throw new Error("WebAuthn assertion was cancelled or returned no credential.");
  }

  const first = assertPrfResult(assertion);
  return {
    prfSeedHex: toHex(first),
    credentialId: toBase64Url(new Uint8Array(assertion.rawId)),
    registered: false,
  };
}

async function registerAndAssertPrfSeed(
  salt: Uint8Array,
): Promise<PrfSeedResult> {
  const userId = randomBytes(16);
  const creation = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: "iyou_home Sovereign Enclave" },
      user: {
        id: userId,
        name: "iyou-home-prf-seed",
        displayName: "iyou_home — Local PRF Seed Credential",
      },
      timeout: PRF_ASSERTION_TIMEOUT_MS,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      extensions: {
        prf: {},
      } as AuthenticationExtensionsClientInputs & PrfExtensionInputs,
    },
  })) as PublicKeyCredential | null;

  if (!creation) {
    throw new Error("Passkey registration was cancelled or failed.");
  }

  // Registration alone does not evaluate the PRF; run a fresh assertion.
  return { ...(await assertPrfSeed(salt)), registered: true };
}

/**
 * Obtains the local WebAuthn PRF seed, registering a discoverable resident
 * credential first if none exists yet.
 *
 * @param saltString Optional UTF-8 salt string fed to the PRF evaluation.
 */
export async function getOrRegisterPrfSeed(
  saltString: string = DEFAULT_PRF_SALT,
): Promise<PrfSeedResult> {
  if (!webauthnPrfSupported()) {
    throw new Error(
      "WebAuthn PRF is unavailable in this context. A secure context (HTTPS or " +
        "the Tauri webview) and a browser with WebAuthn support are required.",
    );
  }

  const salt = saltToBuffer(saltString);

  try {
    return await assertPrfSeed(salt);
  } catch (err) {
    const name =
      err instanceof DOMException
        ? err.name
        : (err as { name?: string })?.name ?? "";
    if (name !== "NotFoundError") {
      // SecurityError / NotAllowedError / InvalidStateError etc. are genuine
      // failures (cancelled prompt, blocked permissions API, bad origin).
      if (name === "NotAllowedError") {
        throw new Error(
          "Biometric authentication was cancelled or timed out. Please try again.",
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    // No discoverable credential yet: register one, then assert against it.
    try {
      return await registerAndAssertPrfSeed(salt);
    } catch (createErr) {
      if (
        createErr instanceof DOMException &&
        createErr.name === "InvalidStateError"
      ) {
        // Credential exists but was excluded from the assertion flow — retry once.
        return await assertPrfSeed(salt);
      }
      throw createErr instanceof Error ? createErr : new Error(String(createErr));
    }
  }
}

/** Re-exported for wizard payload plumbing; keeps BufferSource details out of UI code. */
export { base64UrlToBuffer };
