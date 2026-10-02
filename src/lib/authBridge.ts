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

export const DEFAULT_IDP_BASE_URL = "https://iyou.me";

export interface SponsorAirlockResponse {
  sponsor_did?: string | null;
  [key: string]: unknown;
}

/**
 * Checks if an ephemeral sponsor DID is waiting at the IdP airlock endpoint
 * (`/auth/airlock/sponsor/`) and auto-peers by bootstrapping it into contacts.
 *
 * Silently ignores 401, 404, network errors or missing sponsor DIDs to ensure
 * offline and direct launches continue unaffected.
 */
export async function checkAndBootstrapSponsor(
  idpBaseUrl: string = DEFAULT_IDP_BASE_URL,
): Promise<string | null> {
  try {
    const baseUrl = idpBaseUrl?.trim().replace(/\/+$/, "");
    if (!baseUrl) return null;

    if (typeof fetch !== "function") return null;

    const response = await fetch(`${baseUrl}/auth/airlock/sponsor/`, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    }).catch(() => null);

    if (!response || !response.ok) {
      return null;
    }

    const data = (await response.json().catch(() => null)) as SponsorAirlockResponse | null;
    const sponsorDid = data?.sponsor_did?.trim();
    if (sponsorDid) {
      await invoke("bootstrap_sponsor_contact", {
        sponsorDid,
        label: "Community Sponsor",
      }).catch(() => null);
      return sponsorDid;
    }
  } catch {
    // Fail-safe: silently ignore 401/404/network errors for offline or direct launches
  }
  return null;
}
