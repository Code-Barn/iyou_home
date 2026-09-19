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

/**
 * First-run lifecycle mirror of the Rust `vault::VaultStatus` enum. The
 * gateway renders for `"Uninitialized"`; `"Corrupt"` is a terminal error
 * state that must never be silently regenerated.
 */
export type VaultStatus = "Uninitialized" | "Ready" | "Corrupt";

export interface Profile {
  profile_id: string;
  profile_name: string;
  name?: string;
  derivation_index: number;
  did: string;
  level: 0 | 1 | 2; // 0 = Anchor, 1 = Public Persona, 2 = Burner
  is_system_reserved: boolean;
  active?: boolean;
  nostr_pubkey_hex?: string;
  credentials?: any[];
  // RFC-006 Universal Profile Metadata (all optional; absent = unset)
  handle?: string; // canonical handle, e.g. "dcbyers13" (no leading @)
  display_name?: string; // e.g. "Dan Byers"
  avatar_url?: string; // content-addressed Blossom URL or HTTPS
  banner_url?: string;
  bio?: string;
  nip05?: string; // canonical "handle@iyou.me" — derived by the enclave
}

export interface RoleProfile {
  role_id: string;
  role_title: string;
  namespace: string;
  role_index: number;
  did: string;
  nostr_pubkey_hex: string;
  organization_did: string;
  accreditation_vc_id?: string;
  delegation_scope: string[];
  level: 3;
  created_at: number;
}

export interface BusinessProfile {
  business_id: string;
  legal_name: string;
  business_index: number;
  did: string;
  nostr_pubkey_hex: string;
  jurisdiction: string;
  registration_number?: string;
  operating_currency: string;
  merchant_endpoints: string[];
  level: 4;
  created_at: number;
}

export type EnclaveProfile = Profile | RoleProfile | BusinessProfile;

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
  /** Signing session grace period in minutes (0 = Always Prompt, 15, 60, 240). */
  signing_grace_period_minutes?: number;
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
  /** RFC-004 neutral age gate sealed bracket record (tier only on wires). */
  age_gate?: AgeGateRecord | null;
  /** RFC-004 §5.2 teen default-protective policies. */
  mutual_contacts_only_dm?: boolean;
  restricted_feed_indexing?: boolean;
  public_persona_broadcast?: boolean;
}

/** RFC-004 three-tier minor framework (mirror of Rust `compliance::AgeTier`). */
export type AgeTier = "child" | "teen" | "adult";

/** Privacy-sealed age bracket stored in preferences under `age_gate`.
 *  `record_sha256` is sealed by the enclave; the component-facing
 *  `onDecision` record (RFC-004 §4.2) omits it. */
export interface AgeGateRecord {
  gate_version: "neutral-v1";
  tier: AgeTier;
  computed_at: number;
  record_sha256?: string;
  month: number;
  year: number;
}

/** Outcome of a legal disclaimer exposure (RFC-004 §6.2). */
export type DisclaimerOutcome = "accepted" | "declined" | "dismissed";

/** One row of the append-only `disclaimer_audit.json` log. */
export interface DisclaimerAuditEntry {
  entry_id: string;
  disclaimer_sha256: string;
  disclaimer_key: string;
  version_label: string;
  shown_at: number;
  accepted_at: number | null;
  locale: string;
  device_id: string;
  presented_did: string;
  outcome: DisclaimerOutcome;
  context: string;
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
  signing_grace_period_minutes: 0,
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
  age_gate: null,
  mutual_contacts_only_dm: false,
  restricted_feed_indexing: false,
  public_persona_broadcast: true,
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

// ---------- Invite Capability Tokens (RFC-002) ----------

/** Issuer / invite tier. Wire values are lowercase: "admin" | "member" | "guest". */
export type InviteTier = "admin" | "member" | "guest";

/** Mirrors the Rust `invites::InviteCapabilityToken` (RFC-002 §3). */
export interface InviteCapabilityToken {
  v: number;
  issuer_did: string;
  /** Empty string = portable across satellites. */
  satellite_id: string;
  /** >= 16 random hex bytes (32+ lowercase hex chars). */
  nonce: string;
  max_uses: number;
  uses_count: number;
  tier: InviteTier;
  created_at: number;
  expires_at: number;
  scope: string[];
  /** Base58 Ed25519 signature over SHA-256(canonical payload). */
  signature: string;
}

/** Outcome of the admission-gate preview (`validate_invite_token`). */
export interface ValidationResult {
  valid: boolean;
  /** RFC-002 denial code when invalid: INVITE_INVALID | EXPIRED | USED | REVOKED. */
  reason?: string | null;
  detail?: string | null;
  issuer_did?: string | null;
  tier?: InviteTier | null;
  expires_at?: number | null;
}

/** One issued invite row (mirrors `invites::InviteRecord`). */
export interface InviteRecord {
  nonce: string;
  /** Full signed token JSON — copyable and QR-encodable. */
  token_json: string;
  issuer_did: string;
  tier: InviteTier;
  created_at: number;
  expires_at: number;
  /** Recipient DID once claimed; null while unclaimed. */
  child_did?: string | null;
  uses_count: number;
  max_uses: number;
  /** "live" | "used" | "revoked" | "expired". */
  status: "live" | "used" | "revoked" | "expired";
}

/** Vetting progress for the issuer badge (RFC-002 §5.2). */
export interface VettingStatus {
  account_age_days: number;
  contact_count: number;
  active_moderation_flags: number;
  account_age_ok: boolean;
  contacts_ok: boolean;
  flags_ok: boolean;
  eligible: boolean;
}

/** Issuer standing (mirrors `invites::IssuerStatus`). */
export interface IssuerStatus {
  did: string;
  role: InviteTier;
  quota_used_last_30d: number;
  /** 0 = unlimited (admin). */
  quota_limit: number;
  vetting: VettingStatus;
}

// ---------- Satellite Admin & Moderation (RFC-003) ----------

/** Result of `admin_probe` — whether the active L1 DID is an authorized
 *  `admin_dids` entry for the connected node. */
export interface AdminProbeResult {
  authorized: boolean;
  admin_did: string | null;
  satellite_id: string | null;
}

/** Member directory row projected from the RFC-002 invite graph. */
export interface MemberRecord {
  did: string;
  joined_at: number | null;
  referrer_did: string | null;
  invite_nonce: string | null;
  flags: number;
  /** "active" | "banned". */
  status: string;
}

/** One row of the `banned_identities` ledger. */
export interface BanRecord {
  event_id: number;
  did: string;
  ban_reason: string;
  banned_by_did: string;
  banned_at: number;
  expires_at: number | null;
  evidence_sha256: string | null;
  scope: string;
  severed_conns: number;
  /** False after `admin_unban` (soft-delete). */
  active: boolean;
  unbanned_at: number | null;
}

/** One append-only `moderation_actions` row. */
export interface ModerationAction {
  action_id: number;
  /** "ban" | "unban" | "sever" | "purge" | "reject". */
  kind: string;
  subject_did: string;
  actor_did: string;
  payload: string;
  created_at: number;
}

/** Aggregate reply for `admin_ban`. */
export interface BanReport {
  ban_id: number;
  did: string;
  severed_conns: number;
  pruned_tokens: number;
  tombstones: number;
  blobs_deleted: number;
  events_broadcast: number;
}

/** Aggregate reply for `admin_purge` / the purge half of `admin_ban`. */
export interface PurgeReport {
  subject_did: string;
  tombstones: number;
  blobs_deleted: number;
  events_broadcast: number;
  /** Event ids tombstoned by this run (kind:1605 refs). */
  tombstoned_ids: string[];
}

// ---------- RFC-005 Custodial Seed Pods ----------

/** RFC-005 custody stage (mirror of Rust custody constants). */
export type CustodyStage = 1 | 2 | 3;

/** 1: Supervised (<13), 2: Teen (13–17), 3: Emancipated (18+). */
export const CUSTODY_STAGE = {
  Supervised: 1 as CustodyStage,
  Teen: 2 as CustodyStage,
  Emancipated: 3 as CustodyStage,
} as const;

/** Status label + pill styling for a custody stage. */
export function custodyLabel(stage: CustodyStage): string {
  switch (stage) {
    case CUSTODY_STAGE.Supervised:
      return "Supervised";
    case CUSTODY_STAGE.Teen:
      return "Teen";
    case CUSTODY_STAGE.Emancipated:
      return "Emancipated";
    default:
      return "Unknown";
  }
}

/**
 * RFC-005 custodial seed pod entry. Metadata + public DIDs ONLY — the parent
 * vault never stores a child's seed or private key (vault post-serialize
 * invariant). Mirror of Rust `vault::ChildPodEntry`.
 */
export interface ChildPodEntry {
  pod_id: string;
  child_did: string;
  child_nostr_pubkey_hex: string;
  child_device_id: string;
  bound_at: number;
  custody_stage: CustodyStage;
  active_grants: string[];
  escrow_ref: string;
  emancipated_at: number | null;
}

/** Scope of a supervisory capability (mirror of `pods::GrantScope`). */
export type GrantScope = "relay" | "contact_approval" | "platform_boundary";

/** Effect of a supervisory capability (mirror of `pods::GrantEffect`). */
export type GrantEffect = "allow" | "deny" | "co_sign_required" | "enforce";

/** One delegable capability inside a `SupervisoryGrant`. */
export interface GrantCapability {
  scope: GrantScope;
  effect: GrantEffect;
  relay_id?: string | null;
  boundary?: string | null;
  threshold?: number | null;
}

/** Canonical display tag mirroring `pods::GrantCapability::display_tag`. */
export function capabilityTag(cap: GrantCapability): string {
  const scopeName =
    cap.scope === "relay"
      ? "Relay"
      : cap.scope === "contact_approval"
        ? "Contact"
        : "Platform";
  switch (cap.effect) {
    case "deny":
      return cap.scope === "relay" ? "Safe Relays Only" : `${scopeName} Restriction`;
    case "co_sign_required":
      return "Co-Sign Required";
    case "enforce":
      return `Enforce ${scopeName} Rules`;
    default:
      return `${scopeName} Access`;
  }
}

/**
 * Expiring supervisory capability grant (kind:9114), Ed25519-signed by the
 * parent's active L1. Mirror of Rust `pods::SupervisoryGrant`.
 */
export interface SupervisoryGrant {
  v: number;
  issuer_did: string;
  subject_did: string;
  pod_id: string;
  nonce: string;
  capabilities: GrantCapability[];
  valid_from: number;
  expires_at: number;
  revocable: boolean;
  signature: string;
}

/** Escrow share holder (mirror of `pods::ShareHolder`). */
export type ShareHolder = "parent" | "satellite" | "sheet";

/**
 * One Shamir escrow share: evaluation point + 33-byte payload
 * (1 byte x ‖ 32 bytes y), base64. A single share reveals nothing.
 */
export interface ShareEnvelope {
  share_index: number;
  payload_b64: string;
  holder: ShareHolder;
}

/**
 * Result of the RFC-005 edge binding ceremony. Share x=1 is already stored in
 * the parent's `escrow_store.json`; x=2 (satellite) and x=3 (cold sheet) are
 * returned for distribution. No seed material ever crosses the wire.
 */
export interface PodEscrowCeremony {
  pod_id: string;
  child_did: string;
  child_nostr_pubkey_hex: string;
  parent_share_b64: string;
  satellite_payload_b64: string;
  sheet_payload_b64: string;
  unlock_at: number;
}
