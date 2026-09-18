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

//! Invite Capability Tokens (RFC-002).
//!
//! Signed, quota-limited admission credentials minted with the active Level 1
//! Ed25519 identity. Every minted token is recorded in a local SQLite ledger
//! (`invites.db`) as an `invite_graph` edge (`parent_did → child_did`, with
//! `child_did = ''` while the invite is unclaimed), a full `issued_tokens`
//! payload row for copy/QR/validation, and a `revoked_nonces` tombstone set.
//!
//! Signature scheme (RFC-002 §3.2):
//!   1. Canonical payload: JSON with alphabetically sorted keys and zero
//!      insignificant whitespace over the ten token fields (signature
//!      excluded).
//!   2. Digest: SHA-256 of the canonical payload bytes.
//!   3. Signature: Ed25519 over the 32-byte digest, base58-encoded.
//!
//! Issuance policy (RFC-002 §5.2):
//!   - Admin:  unlimited issuance of any tier (locally scoped via the
//!             `issuers` table, operator-configured).
//!   - Member: member-tier tokens only, ≤ 3 per rolling 30-day window,
//!             gated on vetting (account age > 14 d, ≥ 5 mutual contacts,
//!             0 active moderation flags).
//!   - Guest:  cannot mint.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use tauri::{AppHandle, Manager};

// ---------- constants (RFC-002 §5.2) ----------

/// Token schema version.
pub const TOKEN_VERSION: u8 = 1;
/// Member issuance cap per rolling 30-day window.
pub const MEMBER_MONTHLY_QUOTA: u32 = 3;
/// Member vetting: account must be older than 14 days.
pub const MEMBER_ACCOUNT_AGE_DAYS: i64 = 14;
/// Member vetting: at least 5 mutual contacts in contacts.json.
pub const MEMBER_MIN_CONTACTS: usize = 5;
/// Upper bound on `valid_days` when minting (RFC §5.1: expiry ≤ 90 d).
pub const MAX_VALID_DAYS: u64 = 90;
/// `max_uses` clamp (RFC §5.1: shared family tokens ≤ 4).
pub const MAX_USES_PER_TOKEN: u32 = 4;
/// Nonce floor: 16 random bytes = 32 lowercase hex chars.
pub const NONCE_MIN_BYTES: usize = 16;

// ---------- wire types ----------

/// Issuer / invite role. Wire values are the lowercase variant names:
/// "admin" | "member" | "guest".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InviteTier {
    Admin,
    Member,
    Guest,
}

impl InviteTier {
    pub fn parse(s: &str) -> Result<InviteTier, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "admin" => Ok(InviteTier::Admin),
            "member" => Ok(InviteTier::Member),
            "guest" => Ok(InviteTier::Guest),
            other => Err(format!(
                "Unknown invite tier '{}' (expected admin | member | guest)",
                other
            )),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            InviteTier::Admin => "admin",
            InviteTier::Member => "member",
            InviteTier::Guest => "guest",
        }
    }
}

/// Signed invite capability token. Field order here is for struct ergonomics;
/// the canonical signing payload is re-sorted alphabetically (see
/// `canonical_payload`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteCapabilityToken {
    pub v: u8,
    pub issuer_did: String,
    /// Empty string = portable across satellites.
    pub satellite_id: String,
    /// >= 16 random hex bytes (32+ lowercase hex chars).
    pub nonce: String,
    pub max_uses: u32,
    pub uses_count: u32,
    /// "admin" | "member" | "guest".
    pub tier: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub scope: Vec<String>,
    /// Base58 Ed25519 signature over SHA-256(canonical payload). Not part of
    /// the signed payload.
    #[serde(default)]
    pub signature: String,
}

/// Outcome of a token gate evaluation. `reason` carries the RFC-002 denial
/// code (`INVITE_INVALID | INVITE_EXPIRED | INVITE_USED | INVITE_REVOKED`)
/// when `valid` is false.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationResult {
    pub valid: bool,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub issuer_did: Option<String>,
    pub tier: Option<String>,
    pub expires_at: Option<u64>,
}

/// One issued invite, rendered for the management table.
#[derive(Debug, Clone, Serialize)]
pub struct InviteRecord {
    pub nonce: String,
    /// Full signed token JSON — copyable and QR-encodable.
    pub token_json: String,
    pub issuer_did: String,
    pub tier: String,
    pub created_at: u64,
    pub expires_at: u64,
    /// Recipient DID once claimed; `None` while unclaimed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_did: Option<String>,
    pub uses_count: u32,
    pub max_uses: u32,
    /// "live" | "used" | "revoked" | "expired".
    pub status: String,
}

/// Issuer standing for the UI badge: role, rolling quota, vetting progress.
#[derive(Debug, Clone, Serialize)]
pub struct VettingStatus {
    pub account_age_days: i64,
    pub contact_count: usize,
    pub active_moderation_flags: usize,
    pub account_age_ok: bool,
    pub contacts_ok: bool,
    pub flags_ok: bool,
    pub eligible: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IssuerStatus {
    pub did: String,
    pub role: String,
    pub quota_used_last_30d: u32,
    /// 0 = unlimited.
    pub quota_limit: u32,
    pub vetting: VettingStatus,
}

// ---------- crypto core (RFC-002 §3) ----------

/// Serialize the ten signed fields as a JSON object with alphabetically
/// sorted keys and no insignificant whitespace.
pub fn canonical_payload(token: &InviteCapabilityToken) -> Result<Vec<u8>, String> {
    let canonical: BTreeMap<String, serde_json::Value> =
        serde_json::from_value(serde_json::json!({
            "v": token.v,
            "issuer_did": token.issuer_did,
            "satellite_id": token.satellite_id,
            "nonce": token.nonce,
            "max_uses": token.max_uses,
            "uses_count": token.uses_count,
            "tier": token.tier,
            "created_at": token.created_at,
            "expires_at": token.expires_at,
            "scope": token.scope,
        }))
        .map_err(|e| format!("Canonical mapping failed: {}", e))?;
    serde_json::to_vec(&canonical)
        .map_err(|e| format!("Canonical serialization failed: {}", e))
}

/// SHA-256 of the canonical payload.
pub fn token_digest(token: &InviteCapabilityToken) -> Result<[u8; 32], String> {
    let mut hasher = Sha256::new();
    hasher.update(canonical_payload(token)?);
    Ok(hasher.finalize().into())
}

/// Extract the Ed25519 public key from a `did:key:z6Mk...` URI by stripping
/// the `did:key:` prefix, the multibase `z`, and the Ed25519 multicodec
/// prefix `0xed01`.
pub fn did_to_verifying_key(did: &str) -> Result<VerifyingKey, String> {
    let rest = did
        .strip_prefix("did:key:")
        .ok_or_else(|| "issuer_did is not a did:key URI".to_string())?;
    let b58 = rest.strip_prefix('z').unwrap_or(rest);
    let bytes = bs58::decode(b58)
        .into_vec()
        .map_err(|e| format!("Invalid base58 in issuer DID: {}", e))?;
    if bytes.len() != 34 || bytes[0] != 0xed || bytes[1] != 0x01 {
        return Err("issuer_did is not an Ed25519 (0xed01) key".to_string());
    }
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&bytes[2..34]);
    VerifyingKey::from_bytes(&pubkey)
        .map_err(|e| format!("Invalid Ed25519 public key: {}", e))
}

/// Sign the token: Ed25519 over SHA-256(canonical payload), base58-encoded.
pub fn sign_token(token: &InviteCapabilityToken, signing_key: &SigningKey) -> Result<String, String> {
    let digest = token_digest(token)?;
    let signature = signing_key.sign(&digest);
    Ok(bs58::encode(signature.to_bytes()).into_string())
}

/// Decode a base58 signature (optional multibase `z` prefix tolerated).
fn decode_signature(sig: &str) -> Result<[u8; 64], String> {
    let b58 = sig.trim().strip_prefix('z').unwrap_or(sig.trim());
    let bytes = bs58::decode(b58)
        .into_vec()
        .map_err(|e| format!("Invalid base58 signature: {}", e))?;
    if bytes.len() != 64 {
        return Err(format!(
            "Signature must be 64 bytes (got {})",
            bytes.len()
        ));
    }
    let mut arr = [0u8; 64];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// Independently verify the token signature against the issuer DID.
pub fn verify_token_signature(token: &InviteCapabilityToken) -> Result<(), String> {
    if token.signature.is_empty() {
        return Err("Token is missing its signature".to_string());
    }
    let verifying_key = did_to_verifying_key(&token.issuer_did)?;
    let digest = token_digest(token)?;
    let signature = Signature::from_bytes(&decode_signature(&token.signature)?);
    verifying_key
        .verify(&digest, &signature)
        .map_err(|_| "Signature verification failed".to_string())
}

/// Fresh nonce: 16 OS-random bytes, lowercase hex.
fn gen_nonce() -> String {
    let mut bytes = [0u8; NONCE_MIN_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- vetting & quota predicates (RFC-002 §5.2) ----------

/// Local standing snapshot feeding the member vetting predicate.
#[derive(Debug, Clone, Copy)]
pub struct VettingSnapshot {
    /// Proxy account creation timestamp (earliest contact `created_at`, or 0).
    pub joined_unix: i64,
    pub contact_count: usize,
    /// RFC-003 moderation-flag count; absent ledger = 0 in v0.2.1.
    pub active_moderation_flags: usize,
}

/// Member vetting: account age > 14 days, ≥ 5 contacts, 0 flags.
pub fn member_eligible(snapshot: &VettingSnapshot, now: u64) -> Result<(), String> {
    let age_days = ((now as i64).saturating_sub(snapshot.joined_unix)) / 86_400;
    if age_days <= MEMBER_ACCOUNT_AGE_DAYS {
        return Err(format!(
            "Member vetting: account age {}d must exceed {}d before issuance",
            age_days, MEMBER_ACCOUNT_AGE_DAYS
        ));
    }
    if snapshot.contact_count < MEMBER_MIN_CONTACTS {
        return Err(format!(
            "Member vetting: need >= {} mutual contacts (have {})",
            MEMBER_MIN_CONTACTS, snapshot.contact_count
        ));
    }
    if snapshot.active_moderation_flags > 0 {
        return Err(format!(
            "Member vetting: issuer has {} active moderation flags",
            snapshot.active_moderation_flags
        ));
    }
    Ok(())
}

/// Enforce the RFC-002 §5.2 issuance matrix for a resolved caller role.
pub fn enforce_issuance_policy(
    caller_role: InviteTier,
    requested: InviteTier,
    used_last_30d: u32,
    quota_limit: Option<u32>,
    vetting: &VettingSnapshot,
    now: u64,
) -> Result<(), String> {
    match caller_role {
        InviteTier::Guest => Err("Guest issuers cannot mint invite tokens".to_string()),
        InviteTier::Admin => {
            // Pre-vetted operators: unlimited issuance of any tier.
            Ok(())
        }
        InviteTier::Member => {
            if requested != InviteTier::Member {
                return Err(format!(
                    "Members may only mint member-tier invites ({} tokens require an admin issuer)",
                    requested.as_str()
                ));
            }
            member_eligible(vetting, now)?;
            if let Some(limit) = quota_limit {
                if used_last_30d >= limit {
                    return Err(format!(
                        "Rolling 30-day issuance quota exhausted ({} of {} used)",
                        used_last_30d, limit
                    ));
                }
            }
            Ok(())
        }
    }
}

/// Build the local standing snapshot. Contacts come from `contacts.json`; the
/// account-age proxy is the earliest contact record. Moderation flags are 0
/// until RFC-003 lands.
pub fn synthesize_vetting_snapshot(app: &AppHandle) -> VettingSnapshot {
    let mut contact_count = 0usize;
    let mut joined_unix = 0i64;
    if let Ok(store) = crate::contacts::load_contact_store(app) {
        contact_count = store.contacts.len();
        joined_unix = store
            .contacts
            .iter()
            .filter_map(|c| (c.created_at > 0).then_some(c.created_at))
            .min()
            .unwrap_or(0);
    }
    VettingSnapshot {
        joined_unix,
        contact_count,
        active_moderation_flags: 0,
    }
}

// ---------- SQLite ledger ----------

/// Mandated DDL from RFC-002 §4 plus the local token/issuer stores.
pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS invite_graph (
            edge_id       INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_did    TEXT NOT NULL,
            child_did     TEXT NOT NULL,
            token_nonce   TEXT NOT NULL UNIQUE,
            tier_at_issue TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            revoked_at    INTEGER NULL,
            banned_under  INTEGER NULL
        );
        CREATE TABLE IF NOT EXISTS revoked_nonces (
            nonce         TEXT PRIMARY KEY,
            revoked_at    INTEGER NOT NULL,
            revoked_by    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS issued_tokens (
            nonce        TEXT PRIMARY KEY,
            token_json   TEXT NOT NULL,
            issuer_did   TEXT NOT NULL,
            tier         TEXT NOT NULL,
            max_uses     INTEGER NOT NULL,
            uses_count   INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            expires_at   INTEGER NOT NULL,
            child_did    TEXT NOT NULL DEFAULT '',
            revoked_at   INTEGER
        );
        CREATE TABLE IF NOT EXISTS issuers (
            did        TEXT PRIMARY KEY,
            role       TEXT NOT NULL CHECK (role IN ('admin','member','guest')),
            updated_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("Failed to init invite ledger schema: {}", e))
}

pub fn invites_db_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("invites.db");
    path
}

/// Open (creating if needed) the invite ledger database.
pub fn invites_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = invites_db_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create invite ledger directory: {}", e))?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| format!("Failed to open invite ledger: {}", e))?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Record a minted token in both the referral graph and the token store.
fn persist_minted_token(conn: &mut Connection, token: &InviteCapabilityToken) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin invite ledger transaction: {}", e))?;
    tx.execute(
        "INSERT INTO issued_tokens (nonce, token_json, issuer_did, tier, max_uses, uses_count, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)",
        params![
            token.nonce,
            serde_json::to_string(token).map_err(|e| format!("Failed to serialize token: {}", e))?,
            token.issuer_did,
            token.tier,
            token.max_uses,
            token.created_at as i64,
            token.expires_at as i64,
        ],
    )
    .map_err(|e| format!("Failed to insert issued token: {}", e))?;
    tx.execute(
        "INSERT INTO invite_graph (parent_did, child_did, token_nonce, tier_at_issue, created_at) VALUES (?1, '', ?2, ?3, ?4)",
        params![token.issuer_did, token.nonce, token.tier, token.created_at as i64],
    )
    .map_err(|e| format!("Failed to insert invite graph edge: {}", e))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit invite ledger: {}", e))?;
    Ok(())
}

/// Number of invites issued by `issuer_did` in the rolling 30-day window.
pub fn quota_used_last_30d(conn: &Connection, issuer_did: &str, now: u64) -> u32 {
    let cutoff = (now as i64).saturating_sub(30 * 86_400);
    conn.query_row(
        "SELECT COUNT(*) FROM issued_tokens WHERE issuer_did = ?1 AND created_at >= ?2",
        params![issuer_did, cutoff],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n.max(0) as u32)
    .unwrap_or(0)
}

pub fn resolve_issuer_role(conn: &Connection, did: &str) -> InviteTier {
    conn.query_row(
        "SELECT role FROM issuers WHERE did = ?1",
        params![did],
        |row| row.get::<_, String>(0),
    )
        .ok()
        .and_then(|r| InviteTier::parse(&r).ok())
        .unwrap_or(InviteTier::Member)
}

/// Operator configuration: upsert an issuer role (RFC-002 admin registry).
pub fn set_issuer_role_in_db(conn: &Connection, did: &str, role: InviteTier) -> Result<(), String> {
    let now = unix_now() as i64;
    conn.execute(
        "INSERT INTO issuers (did, role, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(did) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at",
        params![did, role.as_str(), now],
    )
    .map_err(|e| format!("Failed to set issuer role: {}", e))?;
    Ok(())
}

pub fn is_nonce_revoked(conn: &Connection, nonce: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM revoked_nonces WHERE nonce = ?1",
        params![nonce],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|e| format!("Failed to check revoked nonces: {}", e))
}

/// Revoke an invite: tombstone the nonce and stamp `revoked_at` on its graph
/// edge and token row (RFC-002 §6.1).
pub fn revoke_invite_nonce(
    conn: &mut Connection,
    nonce: &str,
    actor_did: &str,
) -> Result<(), String> {
    let now = unix_now() as i64;
    // Refuse to revoke an unknown nonce — fail closed.
    let known = conn
        .query_row(
            "SELECT 1 FROM issued_tokens WHERE nonce = ?1",
            params![nonce],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| format!("Failed to look up nonce: {}", e))?
        .is_some();
    if !known {
        return Err(format!("No invite found for nonce '{}'", nonce));
    }
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to begin revocation transaction: {}", e))?;
    tx.execute(
        "INSERT OR IGNORE INTO revoked_nonces (nonce, revoked_at, revoked_by) VALUES (?1, ?2, ?3)",
        params![nonce, now, actor_did],
    )
    .map_err(|e| format!("Failed to tombstone revoked nonce: {}", e))?;
    tx.execute(
        "UPDATE issued_tokens SET revoked_at = ?1 WHERE nonce = ?2",
        params![now, nonce],
    )
    .map_err(|e| format!("Failed to stamp revoked token: {}", e))?;
    tx.execute(
        "UPDATE invite_graph SET revoked_at = ?1 WHERE token_nonce = ?2 AND revoked_at IS NULL",
        params![now, nonce],
    )
    .map_err(|e| format!("Failed to stamp revoked graph edge: {}", e))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit revocation: {}", e))?;
    Ok(())
}

/// Full list of issued invites, newest first, with computed status evaluated
/// at `now`.
pub fn list_invite_records(conn: &Connection, now: u64) -> Result<Vec<InviteRecord>, String> {
    let now = now as i64;
    let mut stmt = conn
        .prepare(
            "SELECT nonce, token_json, issuer_did, tier, max_uses, uses_count, created_at, expires_at, child_did, revoked_at
             FROM issued_tokens ORDER BY created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare invite listing: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<i64>>(9)?,
            ))
        })
        .map_err(|e| format!("Failed to query invites: {}", e))?;

    let mut records = Vec::new();
    for row in rows {
        let (nonce, token_json, issuer_did, tier, max_uses, uses_count, created_at, expires_at, child_did, revoked_at) =
            row.map_err(|e| format!("Failed to decode invite row: {}", e))?;
        let child = if child_did.is_empty() {
            None
        } else {
            Some(child_did)
        };
        let status = if revoked_at.is_some() {
            "revoked".to_string()
        } else if child.is_some() {
            "used".to_string()
        } else if expires_at < now {
            "expired".to_string()
        } else {
            "live".to_string()
        };
        records.push(InviteRecord {
            nonce,
            token_json,
            issuer_did,
            tier,
            created_at: created_at.max(0) as u64,
            expires_at: expires_at.max(0) as u64,
            child_did: child,
            uses_count: uses_count.max(0) as u32,
            max_uses: max_uses.max(0) as u32,
            status,
        });
    }
    Ok(records)
}

/// Look up the locally tracked uses/claimant for a nonce (None if the token
/// was minted elsewhere).
pub fn lookup_issued_uses(
    conn: &Connection,
    nonce: &str,
) -> Result<Option<(u32, String)>, String> {
    conn.query_row(
        "SELECT uses_count, child_did FROM issued_tokens WHERE nonce = ?1",
        params![nonce],
        |row| {
            Ok((
                row.get::<_, i64>(0)?.max(0) as u32,
                row.get::<_, String>(1)?,
            ))
        },
    )
    .optional()
    .map_err(|e| format!("Failed to look up issued token: {}", e))
}

/// Node-side consumption primitive (reserved for the future admission
/// handshake): binds the invite to a child DID and advances the ledger use
/// count. Not yet wired to IPC — Milestone 1 exposes the gate preview only.
/// Exercised by unit tests.
#[allow(dead_code)]
pub(crate) fn consume_token(conn: &Connection, nonce: &str, child_did: &str) -> Result<(), String> {
    if child_did.is_empty() {
        return Err("Refusing to consume invite for an empty child DID".to_string());
    }
    let affected = conn
        .execute(
            "UPDATE issued_tokens SET uses_count = uses_count + 1,
                    child_did = CASE WHEN child_did = '' THEN ?1 ELSE child_did END
             WHERE nonce = ?2",
            params![child_did, nonce],
        )
        .map_err(|e| format!("Failed to consume token: {}", e))?;
    if affected == 0 {
        return Err(format!("Unknown token nonce '{}'", nonce));
    }
    conn.execute(
        "UPDATE invite_graph SET child_did = ?1 WHERE token_nonce = ?2 AND (child_did = '' OR child_did = ?1)",
        params![child_did, nonce],
    )
    .map_err(|e| format!("Failed to update invite graph: {}", e))?;
    Ok(())
}

// ---------- gate evaluation (RFC-002 §6.2) ----------

/// Denial reasons mapped to RFC-002 codes.
#[derive(Debug, Clone, PartialEq)]
pub enum DenialReason {
    Invalid(String),
    Expired,
    Used,
    Revoked,
}

impl DenialReason {
    pub fn code(&self) -> &'static str {
        match self {
            DenialReason::Invalid(_) => "INVITE_INVALID",
            DenialReason::Expired => "INVITE_EXPIRED",
            DenialReason::Used => "INVITE_USED",
            DenialReason::Revoked => "INVITE_REVOKED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            DenialReason::Invalid(detail) => detail.clone(),
            DenialReason::Expired => "Token has expired".to_string(),
            DenialReason::Used => "Token has exhausted its use budget".to_string(),
            DenialReason::Revoked => "Token has been revoked by its issuer".to_string(),
        }
    }
}

/// Validate a token at the admission gate. Order matters and is fail-fast:
/// schema → expiry → signature → revocation → use budget → replay/self-claim.
pub fn validate_token(
    token: &InviteCapabilityToken,
    now: u64,
    is_revoked: bool,
    known_uses: Option<u32>,
    claimed_child: Option<&str>,
    presenting_did: &str,
) -> Result<(), DenialReason> {
    if token.v != TOKEN_VERSION {
        return Err(DenialReason::Invalid(format!(
            "Unsupported token version {}",
            token.v
        )));
    }
    if InviteTier::parse(&token.tier).is_err() {
        return Err(DenialReason::Invalid(format!(
            "Unknown token tier '{}'",
            token.tier
        )));
    }
    if token.nonce.len() < NONCE_MIN_BYTES * 2
        || !token.nonce.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(DenialReason::Invalid(
            "Nonce must be >= 16 hex bytes (32 hex chars)".to_string(),
        ));
    }
    if token.max_uses == 0 {
        return Err(DenialReason::Invalid(
            "Token max_uses must be >= 1".to_string(),
        ));
    }
    if token.issuer_did.is_empty() {
        return Err(DenialReason::Invalid(
            "Token is missing issuer_did".to_string(),
        ));
    }
    if presenting_did.trim().is_empty() {
        return Err(DenialReason::Invalid(
            "Presenting DID must not be empty".to_string(),
        ));
    }
    if presenting_did.trim() == token.issuer_did {
        return Err(DenialReason::Invalid(
            "Self-invitation denied: presenting DID matches issuer_did".to_string(),
        ));
    }
    if token.expires_at <= now {
        return Err(DenialReason::Expired);
    }
    verify_token_signature(token).map_err(DenialReason::Invalid)?;
    if is_revoked {
        return Err(DenialReason::Revoked);
    }
    if let Some(claimed) = claimed_child {
        if !claimed.is_empty() && claimed != presenting_did.trim() {
            return Err(DenialReason::Used);
        }
    }
    let uses = known_uses.unwrap_or(token.uses_count).max(token.uses_count);
    if uses >= token.max_uses {
        return Err(DenialReason::Used);
    }
    Ok(())
}

// ---------- high-level mint (called from lib.rs) ----------

/// Mint, sign, and persist an invite token as the active L1 identity.
pub fn mint_invite_token(
    app: &AppHandle,
    signing_key: &SigningKey,
    issuer_did: &str,
    tier: &str,
    max_uses: u32,
    valid_days: u64,
    scope: Vec<String>,
    satellite_id: Option<String>,
) -> Result<InviteCapabilityToken, String> {
    let vetting = synthesize_vetting_snapshot(app);
    let mut conn = invites_connection(app)?;
    mint_token_core(
        &mut conn,
        signing_key,
        issuer_did,
        tier,
        max_uses,
        valid_days,
        scope,
        satellite_id,
        &vetting,
        unix_now(),
    )
}

/// Testable core of `mint_invite_token` with injected connection/snapshot/now.
pub(crate) fn mint_token_core(
    conn: &mut Connection,
    signing_key: &SigningKey,
    issuer_did: &str,
    tier: &str,
    max_uses: u32,
    valid_days: u64,
    scope: Vec<String>,
    satellite_id: Option<String>,
    vetting: &VettingSnapshot,
    now: u64,
) -> Result<InviteCapabilityToken, String> {
    let requested = InviteTier::parse(tier)?;
    if max_uses == 0 || max_uses > MAX_USES_PER_TOKEN {
        return Err(format!(
            "max_uses must be between 1 and {}",
            MAX_USES_PER_TOKEN
        ));
    }
    let valid_days = valid_days.clamp(1, MAX_VALID_DAYS);

    let role = resolve_issuer_role(conn, issuer_did);
    let used_last_30d = quota_used_last_30d(conn, issuer_did, now);
    let quota_limit = if role == InviteTier::Admin {
        None
    } else {
        Some(MEMBER_MONTHLY_QUOTA)
    };
    enforce_issuance_policy(role, requested, used_last_30d, quota_limit, vetting, now)?;

    let mut token = InviteCapabilityToken {
        v: TOKEN_VERSION,
        issuer_did: issuer_did.to_string(),
        satellite_id: satellite_id.unwrap_or_default(),
        nonce: gen_nonce(),
        max_uses,
        uses_count: 0,
        tier: requested.as_str().to_string(),
        created_at: now,
        expires_at: now.saturating_add(valid_days.saturating_mul(86_400)),
        scope,
        signature: String::new(),
    };
    let signature = sign_token(&token, signing_key)?;
    token.signature = signature;

    persist_minted_token(conn, &token)?;
    Ok(token)
}

/// Issuer status snapshot for the UI badge, resolved for `did` (the caller
/// resolves the active L1 identity exactly like the minting command does).
pub fn issuer_status(app: &AppHandle, did: &str) -> Result<IssuerStatus, String> {
    let conn = invites_connection(app)?;
    let now = unix_now();
    let role = resolve_issuer_role(&conn, did);
    let quota_used_last_30d = quota_used_last_30d(&conn, did, now);
    let snapshot = synthesize_vetting_snapshot(app);
    let age_days = (((now as i64).saturating_sub(snapshot.joined_unix)) / 86_400).max(0);
    let account_age_ok = age_days > MEMBER_ACCOUNT_AGE_DAYS;
    let contacts_ok = snapshot.contact_count >= MEMBER_MIN_CONTACTS;
    let flags_ok = snapshot.active_moderation_flags == 0;
    Ok(IssuerStatus {
        did: did.to_string(),
        role: role.as_str().to_string(),
        quota_used_last_30d,
        quota_limit: if role == InviteTier::Admin {
            0
        } else {
            MEMBER_MONTHLY_QUOTA
        },
        vetting: VettingStatus {
            account_age_days: age_days,
            contact_count: snapshot.contact_count,
            active_moderation_flags: snapshot.active_moderation_flags,
            account_age_ok,
            contacts_ok,
            flags_ok,
            eligible: account_age_ok && contacts_ok && flags_ok,
        },
    })
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_signing_key() -> SigningKey {
        // Deterministic keypair via the vault derivation path (index 1 = L1
        // public persona) so DIDs and signatures are reproducible.
        crate::vault::derive_deterministic_keypair(&[0x5e; 32], 1).signing_key
    }

    fn test_did() -> String {
        crate::vault::derive_deterministic_keypair(&[0x5e; 32], 1).did
    }

    /// Build an unsigned test token with a safe expiry window.
    fn base_token() -> InviteCapabilityToken {
        InviteCapabilityToken {
            v: TOKEN_VERSION,
            issuer_did: test_did(),
            satellite_id: String::new(),
            nonce: "aabbccddeeff00112233445566778899".to_string(),
            max_uses: 2,
            uses_count: 0,
            tier: "member".to_string(),
            created_at: 1_700_000_000,
            expires_at: 1_710_000_000,
            scope: vec!["join".to_string()],
            signature: String::new(),
        }
    }

    /// Build and sign a token ready for gate evaluation.
    fn signed_token() -> InviteCapabilityToken {
        let signing_key = test_signing_key();
        let mut t = base_token();
        t.signature = sign_token(&t, &signing_key).expect("sign");
        t
    }

    /// Canonical verification time: between token creation and expiry.
    fn now() -> u64 {
        1_700_086_400
    }

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        init_schema(&conn).expect("schema");
        conn
    }

    #[test]
    fn canonical_payload_is_sorted_and_compact() {
        let token = signed_token();
        let payload = canonical_payload(&token).expect("canonical");
        let text = String::from_utf8(payload).expect("utf8");
        // Field keys must be alphabetically sorted with zero insignificant
        // whitespace.
        let keys_in_order = [
            "created_at",
            "expires_at",
            "issuer_did",
            "max_uses",
            "nonce",
            "satellite_id",
            "scope",
            "tier",
            "uses_count",
            "v",
        ];
        let mut idx = 0;
        for key in &keys_in_order {
            let quoted = format!("\"{}\":", key);
            let pos = text.find(&quoted).expect("key present");
            assert!(pos >= idx, "keys out of alphabetical order: {}", key);
            idx = pos + quoted.len();
        }
        assert!(text.starts_with(r#"{"created_at":"#));
        assert!(text.ends_with(r#","v":1}"#));
        assert!(!text.contains(": "), "no insignificant whitespace after colon");
        assert!(!text.contains(", "), "no insignificant whitespace after comma");
    }

    #[test]
    fn token_digest_matches_sha256_of_canonical() {
        let token = signed_token();
        let digest = token_digest(&token).expect("digest");
        let canonical = canonical_payload(&token).expect("canonical");
        let mut hasher = Sha256::new();
        hasher.update(&canonical);
        let expected: [u8; 32] = hasher.finalize().into();
        assert_eq!(digest, expected);
    }

    #[test]
    fn signature_round_trip_verifies_against_did_key() {
        let token = signed_token();
        assert!(!token.signature.is_empty());
        assert!(verify_token_signature(&token).is_ok(), "valid signature should verify");
    }

    #[test]
    fn did_key_pubkey_extraction_rejects_foreign_multicodec() {
        // Short gibberish with wrong length; the function must reject before key parse.
        let err = did_to_verifying_key("did:key:z6Mkabc123").unwrap_err();
        assert!(err.contains("Ed25519") || err.contains("length"), "unexpected: {}", err);
    }

    #[test]
    fn tampered_token_fails_signature() {
        let mut token = signed_token();
        // Tamper with a signed field.
        token.tier = "admin".to_string();
        let err = verify_token_signature(&token).unwrap_err();
        assert!(err.contains("Signature verification failed"), "unexpected: {}", err);

        // Tamper with the signature itself.
        token.tier = "member".to_string();
        let original = token.signature.clone();
        token.signature = format!("z{}", &original[..original.len().saturating_sub(1)]);
        assert!(verify_token_signature(&token).is_err());
    }

    #[test]
    fn expired_token_denied() {
        let signing_key = test_signing_key();
        let mut expired = base_token();
        expired.expires_at = 1_700_000_100; // well before now
        expired.signature = sign_token(&expired, &signing_key).expect("sign");
        let err = validate_token(&expired, now(), false, None, None, "did:key:z6Mkrecv").unwrap_err();
        assert_eq!(err, DenialReason::Expired);
        assert_eq!(err.code(), "INVITE_EXPIRED");

        // Boundary: expires_at == now → expired.
        let mut boundary = base_token();
        boundary.expires_at = now();
        boundary.signature = sign_token(&boundary, &signing_key).expect("sign");
        let err2 = validate_token(&boundary, now(), false, None, None, "did:key:z6Mkrecv").unwrap_err();
        assert_eq!(err2, DenialReason::Expired);
    }

    #[test]
    fn revoked_nonce_denied() {
        let mut conn = mem_db();
        let signing_key = test_signing_key();
        let mut token = signed_token();
        token.nonce = "11111111111111111111111111111111".to_string();
        token.signature = sign_token(&token, &signing_key).expect("sign");

        // Nonce unknown → revoke fails closed.
        revoke_invite_nonce(&mut conn, &token.nonce, &token.issuer_did).unwrap_err();
        assert!(!is_nonce_revoked(&conn, &token.nonce).expect("query"));

        // Persist then revoke.
        persist_minted_token(&mut conn, &token).expect("persist");
        revoke_invite_nonce(&mut conn, &token.nonce, &token.issuer_did).expect("revoke");
        assert!(is_nonce_revoked(&conn, &token.nonce).expect("query"));
        let err = validate_token(&token, now(), true, None, None, "did:key:z6Mkrecv").unwrap_err();
        assert_eq!(err, DenialReason::Revoked);
        assert_eq!(err.code(), "INVITE_REVOKED");
    }

    #[test]
    fn used_up_and_replay_denied() {
        let signing_key = test_signing_key();
        // Exhausted use budget: sign a token that has uses_count=1 (== max_uses).
        let mut exhausted = base_token();
        exhausted.uses_count = 1;
        exhausted.max_uses = 1;
        exhausted.signature = sign_token(&exhausted, &signing_key).expect("sign");
        let err = validate_token(&exhausted, now(), false, None, None, "did:key:z6Mkrecv").unwrap_err();
        assert_eq!(err, DenialReason::Used);

        // Replay: token already claimed by a different DID.
        let token = signed_token();
        let err2 = validate_token(&token, now(), false, None, Some("did:key:z6Mkowner"), "did:key:z6Mkevil").unwrap_err();
        assert_eq!(err2, DenialReason::Used);

        // Claimant itself may present again while under the use budget.
        assert!(
            validate_token(&token, now(), false, None, Some("did:key:z6Mkrecv"), "did:key:z6Mkrecv").is_ok(),
            "claimant may present their own token"
        );
    }

    #[test]
    fn self_invitation_denied() {
        // Unsigned token is fine: self-claim is caught at step 6 (before
        // signature check at step 8).
        let token = base_token();
        // Presenting DID matches issuer.
        let err = validate_token(&token, now(), false, None, None, &token.issuer_did).unwrap_err();
        assert_eq!(err.code(), "INVITE_INVALID");
    }

    #[test]
    fn member_vetting_boundaries() {
        let now = now();
        let fresh = VettingSnapshot { joined_unix: (now as i64) - 14 * 86_400, contact_count: 5, active_moderation_flags: 0 };
        // Exactly 14 days is NOT > 14.
        let err = enforce_issuance_policy(InviteTier::Member, InviteTier::Member, 0, Some(3), &fresh, now).unwrap_err();
        assert!(err.contains("14d"), "unexpected: {}", err);
        let old = VettingSnapshot { joined_unix: (now as i64) - 15 * 86_400, contact_count: 5, active_moderation_flags: 0 };
        assert!(enforce_issuance_policy(InviteTier::Member, InviteTier::Member, 0, Some(3), &old, now).is_ok());
        // Too few contacts.
        let few = VettingSnapshot { joined_unix: (now as i64) - 60 * 86_400, contact_count: 4, active_moderation_flags: 0 };
        let err = enforce_issuance_policy(InviteTier::Member, InviteTier::Member, 0, Some(3), &few, now).unwrap_err();
        assert!(err.contains("contacts"), "unexpected: {}", err);
        // Active moderation flags block issuance.
        let flagged = VettingSnapshot { joined_unix: (now as i64) - 60 * 86_400, contact_count: 5, active_moderation_flags: 1 };
        let err = enforce_issuance_policy(InviteTier::Member, InviteTier::Member, 0, Some(3), &flagged, now).unwrap_err();
        assert!(err.contains("moderation"), "unexpected: {}", err);
        // Member cannot mint admin-tier invites.
        let old = VettingSnapshot { joined_unix: (now as i64) - 60 * 86_400, contact_count: 5, active_moderation_flags: 0 };
        let err = enforce_issuance_policy(InviteTier::Member, InviteTier::Admin, 0, Some(3), &old, now).unwrap_err();
        assert!(err.contains("only mint member-tier"), "unexpected: {}", err);
    }

    #[test]
    fn guest_cannot_issue_and_admin_unlimited() {
        let now = now();
        let snapshot = VettingSnapshot { joined_unix: (now as i64) - 60 * 86_400, contact_count: 5, active_moderation_flags: 0 };
        assert!(enforce_issuance_policy(InviteTier::Guest, InviteTier::Member, 0, Some(3), &snapshot, now).is_err());
        // Admin: far past quota, still mintable.
        assert!(enforce_issuance_policy(InviteTier::Admin, InviteTier::Admin, 999, None, &snapshot, now).is_ok());
        assert!(enforce_issuance_policy(InviteTier::Admin, InviteTier::Guest, 999, None, &snapshot, now).is_ok());
    }

    #[test]
    fn member_quota_exhaustion_rejects_fourth() {
        let mut conn = mem_db();
        let signing_key = test_signing_key();
        let kp = crate::vault::derive_deterministic_keypair(&[0x5e; 32], 1);
        let now = now();
        let snapshot = VettingSnapshot { joined_unix: (now as i64) - 60 * 86_400, contact_count: 5, active_moderation_flags: 0 };

        // Mint 3 invites within the window — all succeed.
        for _ in 0..3 {
            let t = mint_token_core(
                &mut conn,
                &signing_key,
                &kp.did,
                "member",
                1,
                30,
                vec!["join".to_string()],
                None,
                &snapshot,
                now,
            )
            .expect("member mint should succeed within quota");
            assert!(verify_token_signature(&t).is_ok());
        }
        assert_eq!(quota_used_last_30d(&conn, &kp.did, now), 3);

        // 4th mint in the window is rejected.
        let err = mint_token_core(
            &mut conn,
            &signing_key,
            &kp.did,
            "member",
            1,
            30,
            vec!["join".to_string()],
            None,
            &snapshot,
            now,
        )
        .unwrap_err();
        assert!(err.contains("quota"), "unexpected: {}", err);

        // Admin role bypasses the quota (still enforced at the policy layer).
        set_issuer_role_in_db(&conn, &kp.did, InviteTier::Admin).expect("promote");
        let promoted = mint_token_core(
            &mut conn,
            &signing_key,
            &kp.did,
            "admin",
            4,
            30,
            vec!["join".to_string(), "relay:read".to_string()],
            None,
            &snapshot,
            now,
        )
        .expect("admin mint should bypass quota");
        assert_eq!(promoted.tier, "admin");
        assert_eq!(quota_used_last_30d(&conn, &kp.did, now), 4);
    }

    #[test]
    fn mint_persists_and_records_computed_status() {
        let mut conn = mem_db();
        let signing_key = test_signing_key();
        let kp = crate::vault::derive_deterministic_keypair(&[0x5e; 32], 1);
        let now = now();
        let snapshot = VettingSnapshot { joined_unix: (now as i64) - 60 * 86_400, contact_count: 5, active_moderation_flags: 0 };

        let token = mint_token_core(
            &mut conn,
            &signing_key,
            &kp.did,
            "member",
            2,
            30,
            vec!["join".to_string()],
            Some("sat.iyou.me".to_string()),
            &snapshot,
            now,
        )
        .expect("mint");

        let records = list_invite_records(&conn, now + 10).expect("list");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].nonce, token.nonce);
        assert_eq!(records[0].issuer_did, kp.did);
        assert_eq!(records[0].tier, "member");
        assert_eq!(records[0].status, "live");
        assert!(records[0].child_did.is_none());
        // Stored token_json round-trips with the minted satellite scope.
        let stored: InviteCapabilityToken =
            serde_json::from_str(&records[0].token_json).expect("token_json parses");
        assert_eq!(stored.satellite_id, "sat.iyou.me");
        assert_eq!(stored.issuer_did, kp.did);

        // Consumption binds the invite to a child DID.
        consume_token(&mut conn, &token.nonce, "did:key:z6Mkchild").expect("consume");
        let records = list_invite_records(&conn, now + 10).expect("list");
        assert_eq!(records[0].status, "used");
        assert_eq!(records[0].child_did.as_deref(), Some("did:key:z6Mkchild"));
        assert_eq!(records[0].uses_count, 1);

        // Revocation wins over "used" in status ordering.
        revoke_invite_nonce(&mut conn, &token.nonce, &kp.did).expect("revoke");
        let records = list_invite_records(&conn, now + 10).expect("list");
        assert_eq!(records[0].status, "revoked");
    }

    #[test]
    fn validate_uses_local_ledger_when_known() {
        let mut conn = mem_db();
        let signing_key = test_signing_key();
        let kp = crate::vault::derive_deterministic_keypair(&[0x5e; 32], 1);
        let now = now();
        let snapshot = VettingSnapshot { joined_unix: (now as i64) - 60 * 86_400, contact_count: 5, active_moderation_flags: 0 };
        let token = mint_token_core(
            &mut conn,
            &signing_key,
            &kp.did,
            "member",
            1,
            30,
            vec!["join".to_string()],
            None,
            &snapshot,
            now,
        )
        .expect("mint");

        // Unknown locally: only the signed payload governs.
        assert!(validate_token(&token, now + 10, false, None, None, "did:key:z6Mkchild").is_ok());

        // Known locally: consumption advances the ledger use count → Used.
        consume_token(&mut conn, &token.nonce, "did:key:z6Mkchild").expect("consume");
        let (uses, child) = lookup_issued_uses(&conn, &token.nonce)
            .expect("lookup")
            .expect("row exists");
        assert_eq!(uses, 1);
        assert_eq!(child, "did:key:z6Mkchild");
        let err = validate_token(&token, now + 10, false, Some(uses), Some(&child), "did:key:z6Mkchild").unwrap_err();
        assert_eq!(err, DenialReason::Used);
    }
}