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

export type TrustLevel = 'level0' | 'level0_5' | 'level1' | 'Level0' | 'Level0_5' | 'Level1';

export interface Profile {
  profile_id: string;
  profile_name: string;
  derivation_index: number;
  did: string;
  level: number; // 0 = Anchor, 1 = Public Persona, 2+ = Burner
  is_system_reserved: boolean;
  nostr_pubkey_hex?: string;
  credentials?: any[];
}

export interface PeerContact {
  peer_id: string;
  display_name: string;
  trust_level: TrustLevel;
  disclosed_aliases: string[];
  attestation_receipt?: string;
  created_at: number;
  updated_at: number;
}
