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

import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_USER_PREFERENCES, UserPreferences } from "./types";

/**
 * App-lock shared helpers: preference loading/saving and PIN hashing.
 *
 * Only hashes of the 6-digit PIN and of the WebAuthn PRF seed are ever
 * persisted — never the secrets themselves.
 */

export const INACTIVITY_TIMEOUT_OPTIONS = [
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 60, label: "1 hour" },
  { value: 0, label: "Never (auto-lock off)" },
] as const;

export async function loadUserPreferences(): Promise<UserPreferences> {
  try {
    const raw = await invoke<UserPreferences | null>("get_user_preferences");
    return raw ? { ...DEFAULT_USER_PREFERENCES, ...raw } : DEFAULT_USER_PREFERENCES;
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export async function saveUserPreferences(prefs: UserPreferences): Promise<void> {
  await invoke("save_user_preferences", { preferences: prefs });
}

/** SHA-256 hex digest of a UTF-8 string, via the platform Web Crypto API. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isValidAppLockPin(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}

export function inactivityMinutesToMs(minutes: number): number {
  return minutes > 0 ? minutes * 60_000 : 0;
}