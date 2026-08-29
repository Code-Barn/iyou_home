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

import { useEffect, useRef, useState } from "react";
import { sha256Hex } from "../../lib/appLock";
import { DEFAULT_PRF_SALT, getOrRegisterPrfSeed, webauthnPrfSupported } from "../../lib/webauthnPrf";

interface AppLockOverlayProps {
  /** SHA-256 of the registered 6-digit PIN, or null when unset. */
  pinHash: string | null;
  /** SHA-256 of the WebAuthn PRF seed, or null when not enrolled. */
  prfHash: string | null;
  /** Configured inactivity auto-lock in minutes (0 = never). */
  autoLockMinutes: number;
  /** Invoked once the user authenticates successfully. */
  onUnlock: () => void;
}

export default function AppLockOverlay({
  pinHash,
  prfHash,
  autoLockMinutes,
  onUnlock,
}: AppLockOverlayProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const biometricAvailable =
    typeof prfHash === "string" && prfHash.length > 0 && webauthnPrfSupported();

  const handleUnlock = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!pinHash) {
        setError("No PIN is configured. Enable app lock from the Vault settings.");
        return;
      }
      const digest = await sha256Hex(pin);
      if (digest === pinHash) {
        onUnlock();
        return;
      }
      setPin("");
      setError("Incorrect PIN. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleBiometric = async () => {
    if (biometricBusy) return;
    setBiometricBusy(true);
    setError(null);
    try {
      if (!prfHash) {
        setError("Biometrics are not enrolled. Use your PIN instead.");
        return;
      }
      const result = await getOrRegisterPrfSeed(DEFAULT_PRF_SALT);
      const digest = await sha256Hex(result.prfSeedHex);
      if (digest === prfHash) {
        onUnlock();
        return;
      }
      setError("Biometric verification failed. Use your PIN instead.");
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBiometricBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background:
          "linear-gradient(160deg, #0f172a 0%, #1e1b4b 55%, #312e81 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#e0e7ff",
      }}
    >
      <div
        style={{
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(199, 210, 254, 0.25)",
          borderRadius: "16px",
          padding: "2.25rem",
          maxWidth: "420px",
          width: "100%",
          textAlign: "center",
          backdropFilter: "blur(8px)",
        }}
      >
        <div
          style={{
            fontSize: "2.5rem",
            marginBottom: "0.5rem",
            color: "#c7d2fe",
          }}
        >
          {"\uD83D\uDD13"}
        </div>
        <h2 style={{ margin: "0 0 0.25rem 0", color: "#fff" }}>iyou_home is locked</h2>
        <p
          style={{
            fontSize: "0.85rem",
            color: "#a5b4fc",
            margin: "0 0 1.5rem 0",
          }}
        >
          {autoLockMinutes > 0
            ? `Auto-locks after ${autoLockMinutes} minute${autoLockMinutes === 1 ? "" : "s"} of inactivity.`
            : "Unlock to continue."}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleUnlock();
          }}
        >
          <label
            style={{
              display: "block",
              fontSize: "0.78rem",
              color: "#a5b4fc",
              marginBottom: "0.35rem",
              textAlign: "left",
            }}
          >
            Enter your 6-digit PIN
          </label>
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="••••••"
            disabled={busy}
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: "8px",
              border: "1px solid #6366f1",
              background: "#0f172a",
              color: "#fff",
              textAlign: "center",
              fontSize: "1.5rem",
              letterSpacing: "0.5em",
            }}
          />
          <button
            type="submit"
            disabled={busy || pin.length !== 6}
            style={{
              width: "100%",
              marginTop: "0.75rem",
              background: "#6366f1",
              color: "#fff",
              border: "none",
              fontWeight: 700,
              padding: "0.75rem",
              borderRadius: "8px",
              opacity: busy || pin.length !== 6 ? 0.5 : 1,
              cursor: busy || pin.length !== 6 ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Checking…" : "Unlock"}
          </button>
        </form>

        {biometricAvailable && (
          <button
            onClick={handleBiometric}
            disabled={biometricBusy}
            style={{
              width: "100%",
              marginTop: "0.75rem",
              background: "transparent",
              border: "1px solid #a5b4fc",
              color: "#e0e7ff",
              padding: "0.75rem",
              borderRadius: "8px",
            }}
          >
            {biometricBusy ? "Verifying…" : "\uD83D\uDC64 Use Biometrics / Passkey"}
          </button>
        )}

        {error && (
          <div
            style={{
              marginTop: "1rem",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#b91c1c",
              borderRadius: "8px",
              padding: "0.75rem 1rem",
              fontSize: "0.85rem",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}