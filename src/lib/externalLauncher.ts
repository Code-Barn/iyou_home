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

import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Returns whether the application is running in local developer mode.
 */
export function isLocalDevMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1" ||
      localStorage.getItem("iyou_home_dev_mode") === "true"
    );
  } catch {
    return false;
  }
}

/**
 * Returns the target URL for iyou_chat (standalone satellite).
 * Local dev defaults to http://127.0.0.1:8017; production to https://chat.iyou.me.
 */
export function getChatAppUrl(peerId?: string): string {
  const base = isLocalDevMode() ? "http://127.0.0.1:8017" : "https://chat.iyou.me";
  if (peerId && peerId.trim()) {
    return `${base}?peer=${encodeURIComponent(peerId.trim())}`;
  }
  return base;
}

/**
 * Opens an external URL via Tauri's external shell opener (@tauri-apps/plugin-opener),
 * falling back gracefully to window.open if running in standard browser/test context.
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (err) {
    console.warn("Failed to open via @tauri-apps/plugin-opener, falling back to window.open", err);
    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }
}
