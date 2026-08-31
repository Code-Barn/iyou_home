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
  name?: string;
  derivation_index: number;
  did: string;
  level: number; // 0 = Anchor, 1 = Public Persona, 2+ = Burner
  is_system_reserved: boolean;
  active?: boolean;
  nostr_pubkey_hex?: string;
  credentials?: any[];
}

export type PersonaProfile = Profile;

export interface PeerContact {
  peer_id: string;
  display_name: string;
  trust_level: TrustLevel;
  disclosed_aliases: string[];
  attestation_receipt?: string;
  created_at: number;
  updated_at: number;
}

/** A routable chat peer — either an Enclave contact or a raw address. */
export interface ChatPeerTarget {
  /** Canonical identifier for display / fingerprint fallback (hex or bare JID). */
  peerId: string;
  /** Petname / display name when known. */
  displayName?: string;
  /** Pre-normalized bare routing JID (e.g. `{hex}@127.0.0.1`). */
  jid?: string;
  /** 64-hex routing key when derivable from the identifier. */
  peerHex?: string;
}

/** A persisted conversation row backing the Messages inbox. */
export interface ChatThread {
  /** Canonical bare JID this thread routes to — stable lookup key. */
  peerJid: string;
  /** Original normalized identifier for display fallback. */
  peerId: string;
  /** Display name / petname for the header and inbox row. */
  displayName: string;
  /** One-line preview of the last message. */
  lastMessageSnippet: string;
  /** Epoch ms of the last activity, used for relative timestamps + sort. */
  lastTimestamp: number;
  /** Inbound messages not yet viewed. */
  unreadCount: number;
}

/** Reported chat activity used to keep inbox metadata fresh. */
export interface ChatActivityEvent {
  peerJid: string;
  direction: "in" | "out";
  body: string;
  encrypted: boolean;
  timestamp: number;
}

/**
 * Mirror of the Rust `UserPreferences` struct. Backend commands:
 * `get_user_preferences` / `save_user_preferences`.
 */
export interface UserPreferences {
  active_profile_id: string;
  default_signing_profile: string;
  auto_sign: boolean;
  last_active_tab: string;
  active_sovereign_did?: string | null;
  last_synced_at: number;
  /** True once the first-run master seed backup ceremony is complete. */
  seed_backup_confirmed: boolean;
  /** Whether the OS biometric / PIN screen guard is enabled. */
  app_lock_enabled: boolean;
  /** Inactivity auto-lock timeout in minutes (5, 15, 60, or 0 = never). */
  inactivity_timeout_minutes: number;
  /** SHA-256 of the local 6-digit PIN (never the PIN itself). */
  app_lock_pin_hash?: string | null;
  /** SHA-256 of the WebAuthn PRF seed hex (never the seed itself). */
  app_lock_prf_hash?: string | null;
  /** Unix timestamp of the last exported encrypted vault backup. */
  last_backup_at?: number;
  /** List of configured public Nostr relays for the gossip mesh. */
  relay_mesh?: string[];
  /** Sovereign update preferences, policies, and channel configuration. */
  update_preferences?: UpdatePreferences;
}

export type UpdatePolicy = 'locked' | 'manual' | 'auto';

export interface UpdatePreferences {
  policy: UpdatePolicy;
  release_channel: string;
  custom_manifest_url?: string | null;
  last_checked_at?: number | null;
  ignored_version?: string | null;
}

export interface UpdateMetadata {
  current_version: string;
  target_version: string;
  git_commit_hash: string;
  binary_sha256: string;
  minisign_signature: string;
  release_notes: string;
  published_at: number;
  download_url: string;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  active_profile_id: "primary",
  default_signing_profile: "primary",
  auto_sign: false,
  last_active_tab: "enclave",
  active_sovereign_did: null,
  last_synced_at: 0,
  seed_backup_confirmed: false,
  app_lock_enabled: false,
  inactivity_timeout_minutes: 15,
  app_lock_pin_hash: null,
  app_lock_prf_hash: null,
  last_backup_at: 0,
  relay_mesh: [
    "wss://relay.iyou.me",
    "wss://nos.lol",
    "wss://relay.damus.io",
  ],
  update_preferences: {
    policy: "manual",
    release_channel: "stable",
    custom_manifest_url: null,
    last_checked_at: null,
    ignored_version: null,
  },
};

export interface KeyCustodyDiagnostic {
  initialized: boolean;
  anchor_initialized: boolean;
  public_persona_initialized: boolean;
  active_did: string;
  profile_count: number;
  sovereign_identities_count: number;
  status: "active" | "uninitialized";
}

export interface LocalIngressRelayDiagnostic {
  service_name: string;
  port: number;
  running: boolean;
  db_exists: boolean;
  events_count: number;
  status: "running" | "stopped";
}

export interface LocalMediaServerDiagnostic {
  service_name: string;
  port: number;
  protocol: string;
  running: boolean;
  blobs_count: number;
  storage_bytes: number;
  status: "running" | "stopped";
}

export interface RelayGossipMeshDiagnostic {
  relays: string[];
  min_required: number;
  configured_count: number;
  mesh_ready: boolean;
  status: "healthy" | "insufficient_relays";
}

export interface EncryptedBackupsDiagnostic {
  last_backup_at: number;
  days_since_backup: number | null;
  is_fresh: boolean;
  seed_backup_confirmed: boolean;
  status: "fresh" | "stale" | "never_exported";
}

export interface EnclaveDiagnostics {
  type: string;
  status: string;
  timestamp: number;
  key_custody: KeyCustodyDiagnostic;
  local_ingress_relay: LocalIngressRelayDiagnostic;
  local_media_server: LocalMediaServerDiagnostic;
  relay_gossip_mesh: RelayGossipMeshDiagnostic;
  encrypted_backups: EncryptedBackupsDiagnostic;
  all_capabilities_met: boolean;
}

export interface TlsStatus {
  is_production_cert: boolean;
  domain: string;
  cert_path: string;
}
