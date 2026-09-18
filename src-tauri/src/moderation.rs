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

//! Satellite Admin & Moderation (RFC-003).
//!
//! Operator tooling for the local node: an append-only `banned_identities`
//! ledger, a `moderation_actions` audit trail, three moderation primitives
//! (sever live connections, reject inbound events pre-store, tombstone &
//! purge authored events/media), RFC-002 invite-branch pruning, and an
//! `admin_dids`-style authorization gate.
//!
//! Ledger layout lives in `moderation.db` (a dedicated app database, per
//! RFC-003 §4 "in `nostr_events.db` or dedicated app database"):
//!
//! ```sql
//! banned_identities -- immutable ban rows (soft-deleted via `active` flag)
//! moderation_actions -- append-only chronological audit trail
//! tombstoned_events  -- purge cascade bookkeeping (T1)
//! ```
//!
//! Authorization: the active Level 1 DID must be registered with role
//! `admin` in the RFC-002 `issuers` registry (`invites.db`), mirroring the
//! node-side `admin_dids` list. Every mutating `admin_*` IPC rejects with
//! `403 Forbidden` when the active L1 DID is not authorized.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use tauri::{AppHandle, Manager};

// ---------- wire types ----------

/// Result of `admin_probe`: whether the active L1 DID is an authorized
/// `admin_dids` entry for the connected node.
#[derive(Debug, Clone, Serialize)]
pub struct AdminProbeResult {
    pub authorized: bool,
    pub admin_did: Option<String>,
    pub satellite_id: Option<String>,
}

/// One row of the member directory: registration time and referral lineage
/// are projected from the RFC-002 `invite_graph`; status reflects the active
/// ban ledger.
#[derive(Debug, Clone, Serialize)]
pub struct MemberRecord {
    pub did: String,
    pub joined_at: Option<u64>,
    pub referrer_did: Option<String>,
    pub invite_nonce: Option<String>,
    /// Moderation flag count (RFC-003 flags; 0 until a flag feed is wired).
    pub flags: u32,
    /// "active" | "banned".
    pub status: String,
}

/// One row of the `banned_identities` ledger.
#[derive(Debug, Clone, Serialize)]
pub struct BanRecord {
    pub event_id: i64,
    pub did: String,
    pub ban_reason: String,
    pub banned_by_did: String,
    pub banned_at: u64,
    pub expires_at: Option<u64>,
    pub evidence_sha256: Option<String>,
    pub scope: String,
    pub severed_conns: u32,
    /// Soft-delete flag: `false` after `admin_unban`.
    pub active: bool,
    pub unbanned_at: Option<u64>,
}

/// One append-only `moderation_actions` row.
#[derive(Debug, Clone, Serialize)]
pub struct ModerationAction {
    pub action_id: i64,
    /// "ban" | "unban" | "sever" | "purge" | "reject".
    pub kind: String,
    pub subject_did: String,
    pub actor_did: String,
    pub payload: String,
    pub created_at: u64,
}

/// Aggregate reply for `admin_ban`.
#[derive(Debug, Clone, Serialize)]
pub struct BanReport {
    pub ban_id: i64,
    pub did: String,
    pub severed_conns: u32,
    pub pruned_tokens: usize,
    pub tombstones: usize,
    pub blobs_deleted: usize,
    pub events_broadcast: usize,
}

/// Aggregate reply for `admin_purge` / the purge half of `admin_ban`.
#[derive(Debug, Clone, Serialize)]
pub struct PurgeReport {
    pub subject_did: String,
    pub tombstones: usize,
    pub blobs_deleted: usize,
    pub events_broadcast: usize,
    /// Event ids tombstoned by this run (referenced by the kind:1605 peer
    /// broadcast).
    pub tombstoned_ids: Vec<String>,
}

// ---------- time ----------

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- database ----------

pub fn moderation_db_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("moderation.db");
    path
}

pub fn relay_db_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("nostr_events.db");
    path
}

pub fn blobs_dir_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("blobs");
    path
}

/// Mandated RFC-003 §4 DDL plus soft-delete columns for `admin_unban`.
pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS banned_identities (
            event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
            did             TEXT NOT NULL,
            ban_reason      TEXT NOT NULL,
            banned_by_did   TEXT NOT NULL,
            banned_at       INTEGER NOT NULL,
            expires_at      INTEGER,
            evidence_sha256 TEXT,
            scope           TEXT NOT NULL DEFAULT 'node',
            severed_conns   INTEGER NOT NULL DEFAULT 0,
            active          INTEGER NOT NULL DEFAULT 1,
            unbanned_at     INTEGER,
            UNIQUE(did, scope)
        );
        CREATE TABLE IF NOT EXISTS moderation_actions (
            action_id   INTEGER PRIMARY KEY AUTOINCREMENT,
            kind        TEXT NOT NULL,
            subject_did TEXT NOT NULL,
            actor_did   TEXT NOT NULL,
            payload     TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tombstoned_events (
            event_id    TEXT PRIMARY KEY,
            subject_did TEXT NOT NULL,
            purged_by   TEXT NOT NULL,
            purged_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_banned_did ON banned_identities(did);
        CREATE INDEX IF NOT EXISTS idx_actions_subject ON moderation_actions(subject_did);
        "#,
    )
    .map_err(|e| format!("Failed to init moderation schema: {}", e))
}

/// Open (creating if needed) the moderation ledger database.
pub fn moderation_connection(app: &AppHandle) -> Result<Connection, String> {
    let path = moderation_db_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create moderation ledger directory: {}", e))?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| format!("Failed to open moderation ledger: {}", e))?;
    init_schema(&conn)?;
    Ok(conn)
}

/// Append a row to `moderation_actions`. Returns the new `action_id`.
/// The audit trail is append-only: unbans and purges add rows, they never
/// mutate or delete prior rows.
pub fn append_action(
    conn: &Connection,
    kind: &str,
    subject_did: &str,
    actor_did: &str,
    payload: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO moderation_actions (kind, subject_did, actor_did, payload, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![kind, subject_did, actor_did, payload, now_unix() as i64],
    )
    .map_err(|e| format!("Failed to append moderation action: {}", e))?;
    Ok(conn.last_insert_rowid())
}

// ---------- access control (admin_dids mirror) ----------

/// True when `actor_did` is registered as an `admin` role in the RFC-002
/// `issuers` registry — the local mirror of the node-side `admin_dids` list.
pub fn is_authorized_admin(invite_conn: &Connection, actor_did: &str) -> bool {
    crate::invites::resolve_issuer_role(invite_conn, actor_did) == crate::invites::InviteTier::Admin
}

/// Resolve the active Level 1 DID and fail closed with `403 Forbidden` unless
/// it is an authorized `admin_dids` entry. Returns the admin DID on success.
pub fn require_admin(app: &AppHandle) -> Result<String, String> {
    let (_, did) = crate::resolve_profile_keypair(app, None)?;
    let invite_conn = crate::invites::invites_connection(app)?;
    if is_authorized_admin(&invite_conn, &did) {
        Ok(did)
    } else {
        Err("403 Forbidden: active L1 DID is not an authorized admin_did".to_string())
    }
}

// ---------- sever (RFC-003 §5.1) ----------

/// Machine-readable termination frame sent to every live socket of a banned
/// DID before the socket is closed.
pub fn build_termination_frame(did: &str, ban_reason: &str, banned_by: &str, ban_id: i64) -> String {
    serde_json::json!({
        "type": "auth_status",
        "status": "denied",
        "code": 403,
        "termination_reason": "BANNED",
        "ban_id": ban_id,
        "ban_reason": ban_reason,
        "banned_by": banned_by,
        "subject_did": did,
    })
    .to_string()
}

/// Terminate `live_conns` live sockets of `did` (count tracked in the
/// in-memory connection registry owned by `ServiceState`; locally this is
/// typically 0 because the client relay accepts only its own identity).
/// Increments `severed_conns` on the active ban row (if any) and appends a
/// `sever` moderation action carrying the typed termination frame.
pub fn sever_connections(
    conn: &mut Connection,
    did: &str,
    live_conns: usize,
    actor_did: &str,
    ban_reason: &str,
    ban_id: Option<i64>,
    scope: &str,
) -> Result<u32, String> {
    let live = live_conns.min(u32::MAX as usize) as u32;
    conn.execute(
        "UPDATE banned_identities SET severed_conns = severed_conns + ?1 \
         WHERE did = ?2 AND scope = ?3 AND active = 1",
        params![live as i64, did, scope],
    )
    .map_err(|e| format!("Failed to increment severed_conns: {}", e))?;

    let frame = build_termination_frame(did, ban_reason, actor_did, ban_id.unwrap_or(0));
    append_action(conn, "sever", did, actor_did, &frame)?;
    Ok(live)
}

// ---------- reject (RFC-003 §5.2) ----------

/// Pre-store gate for inbound `EVENT` frames: `Ok(())` when the pubkey is
/// clean, `Err("BANNED: <reason>")` when a non-expired active ban matches.
pub fn reject_if_banned(conn: &Connection, pubkey_or_did: &str) -> Result<(), String> {
    let now = now_unix() as i64;
    let reason: Option<String> = conn
        .query_row(
            "SELECT ban_reason FROM banned_identities \
             WHERE did = ?1 AND active = 1 AND (expires_at IS NULL OR expires_at > ?2)",
            params![pubkey_or_did, now],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query banned identities: {}", e))?;
    match reason {
        Some(reason) => Err(format!("BANNED: {}", reason)),
        None => Ok(()),
    }
}

// ---------- ban / unban ledger ----------

/// Insert a ban row (reactivating a soft-deleted row for the same
/// `(did, scope)` to preserve the `UNIQUE(did, scope)` invariant) and append
/// a `ban` audit entry. Returns the ban row id.
pub fn insert_ban(
    conn: &mut Connection,
    did: &str,
    reason: &str,
    actor_did: &str,
    scope: &str,
    expires_at: Option<u64>,
    evidence_sha256: Option<&str>,
) -> Result<i64, String> {
    let now = now_unix() as i64;
    let scope = if scope.trim().is_empty() {
        "node"
    } else {
        scope
    };
    let existing: Option<i64> = conn
        .query_row(
            "SELECT event_id FROM banned_identities WHERE did = ?1 AND scope = ?2",
            params![did, scope],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to look up existing ban: {}", e))?;

    let ban_id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE banned_identities SET ban_reason = ?1, banned_by_did = ?2, banned_at = ?3, \
                 expires_at = ?4, evidence_sha256 = ?5, severed_conns = 0, active = 1, \
                 unbanned_at = NULL WHERE event_id = ?6",
                params![reason, actor_did, now, expires_at, evidence_sha256, id],
            )
            .map_err(|e| format!("Failed to reactivate ban row: {}", e))?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO banned_identities \
                 (did, ban_reason, banned_by_did, banned_at, expires_at, evidence_sha256, scope) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    did,
                    reason,
                    actor_did,
                    now,
                    expires_at,
                    evidence_sha256,
                    scope
                ],
            )
            .map_err(|e| format!("Failed to insert ban: {}", e))?;
            conn.last_insert_rowid()
        }
    };

    let payload = serde_json::json!({
        "scope": scope,
        "expires_at": expires_at,
        "evidence_sha256": evidence_sha256,
    })
    .to_string();
    append_action(conn, "ban", did, actor_did, &payload)?;
    Ok(ban_id)
}

/// Soft-delete an active ban row (`active = 0`). The immutable `ban` audit
/// row survives; `admin_unban` appends an `unban` action.
pub fn soft_delete_ban(conn: &mut Connection, did: &str, actor_did: &str) -> Result<(), String> {
    let now = now_unix() as i64;
    let changed = conn
        .execute(
            "UPDATE banned_identities SET active = 0, unbanned_at = ?1 \
             WHERE did = ?2 AND active = 1",
            params![now, did],
        )
        .map_err(|e| format!("Failed to soft-delete ban: {}", e))?;
    if changed == 0 {
        return Err(format!("No active ban found for DID '{}'", did));
    }
    append_action(conn, "unban", did, actor_did, "{\"soft_delete\":true}")?;
    Ok(())
}

/// List `banned_identities` rows. `include_inactive` adds soft-deleted and
/// expired rows for the audit view; the default view returns only live bans.
pub fn list_bans(conn: &Connection, include_inactive: bool) -> Result<Vec<BanRecord>, String> {
    let now = now_unix() as i64;
    let rows = if include_inactive {
        let mut stmt = conn
            .prepare(
                "SELECT event_id, did, ban_reason, banned_by_did, banned_at, expires_at, \
                 evidence_sha256, scope, severed_conns, active, unbanned_at \
                 FROM banned_identities ORDER BY banned_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], map_ban_row)
            .map_err(|e| format!("Failed to query bans: {}", e))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT event_id, did, ban_reason, banned_by_did, banned_at, expires_at, \
                 evidence_sha256, scope, severed_conns, active, unbanned_at \
                 FROM banned_identities WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?1) \
                 ORDER BY banned_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map(params![now], map_ban_row)
            .map_err(|e| format!("Failed to query bans: {}", e))?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
}

fn map_ban_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BanRecord> {
    Ok(BanRecord {
        event_id: row.get(0)?,
        did: row.get(1)?,
        ban_reason: row.get(2)?,
        banned_by_did: row.get(3)?,
        banned_at: row.get::<_, i64>(4)? as u64,
        expires_at: row.get::<_, Option<i64>>(5)?.map(|v| v as u64),
        evidence_sha256: row.get(6)?,
        scope: row.get(7)?,
        severed_conns: row.get::<_, i64>(8)? as u32,
        active: row.get::<_, i64>(9)? != 0,
        unbanned_at: row.get::<_, Option<i64>>(10)?.map(|v| v as u64),
    })
}

/// Chronological moderation audit trail (newest first).
pub fn list_actions(conn: &Connection, limit: u32) -> Result<Vec<ModerationAction>, String> {
    let limit = limit.clamp(1, 1000);
    let mut stmt = conn
        .prepare(
            "SELECT action_id, kind, subject_did, actor_did, payload, created_at \
             FROM moderation_actions ORDER BY action_id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit as i64], |row| {
            Ok(ModerationAction {
                action_id: row.get(0)?,
                kind: row.get(1)?,
                subject_did: row.get(2)?,
                actor_did: row.get(3)?,
                payload: row.get(4)?,
                created_at: row.get::<_, i64>(5)? as u64,
            })
        })
        .map_err(|e| format!("Failed to query moderation actions: {}", e))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

// ---------- member directory (RFC-003 §6) ----------

/// Project the member directory from the RFC-002 invite graph: every DID that
/// ever minted an invite or claimed one, plus the active Level 1 operator
/// DID. `joined_at` is the earliest graph event; `referrer_did`/`invite_nonce`
/// come from the edge where the DID is the claimed child.
pub fn list_members(
    mod_conn: &Connection,
    invite_conn: &Connection,
    active_l1_did: &str,
    now: u64,
) -> Result<Vec<MemberRecord>, String> {
    let mut joined: BTreeMap<String, u64> = BTreeMap::new();
    let mut referrer: BTreeMap<String, (String, String)> = BTreeMap::new();

    let mut stmt = invite_conn
        .prepare(
            "SELECT parent_did, child_did, token_nonce, created_at \
             FROM invite_graph ORDER BY created_at ASC, edge_id ASC",
        )
        .map_err(|e| format!("Failed to read invite graph: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|e| format!("Failed to query invite graph: {}", e))?;

    for row in rows {
        let (parent, child, nonce, created) = row.map_err(|e| e.to_string())?;
        let created = created.max(0) as u64;
        joined
            .entry(parent.clone())
            .and_modify(|v| *v = (*v).min(created))
            .or_insert(created);
        if !child.is_empty() {
            joined
                .entry(child.clone())
                .and_modify(|v| *v = (*v).min(created))
                .or_insert(created);
            referrer.entry(child).or_insert((parent, nonce));
        }
    }

    // The operator's own identity is always a member of their node.
    if !active_l1_did.trim().is_empty() {
        joined.entry(active_l1_did.to_string()).or_insert(0);
    }

    // Live ban set (non-expired, not soft-deleted).
    let mut banned: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stmt = mod_conn
        .prepare(
            "SELECT did FROM banned_identities \
             WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?1)",
        )
        .map_err(|e| format!("Failed to read ban ledger: {}", e))?;
    let rows = stmt
        .query_map(params![now as i64], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query ban ledger: {}", e))?;
    for row in rows {
        let did = row.map_err(|e| e.to_string())?;
        if !did.is_empty() {
            banned.insert(did);
        }
    }

    let mut members: Vec<MemberRecord> = joined
        .into_iter()
        .filter(|(did, _)| !did.trim().is_empty())
        .map(|(did, joined_at)| {
            let (parent, nonce) = referrer.get(&did).cloned().unwrap_or_default();
            MemberRecord {
                did: did.clone(),
                joined_at: if joined_at == 0 { None } else { Some(joined_at) },
                referrer_did: if parent.is_empty() { None } else { Some(parent) },
                invite_nonce: if nonce.is_empty() { None } else { Some(nonce) },
                flags: 0,
                status: if banned.contains(&did) {
                    "banned".to_string()
                } else {
                    "active".to_string()
                },
            }
        })
        .collect();

    members.sort_by(|a, b| b.joined_at.unwrap_or(0).cmp(&a.joined_at.unwrap_or(0)));
    Ok(members)
}

// ---------- tombstone & purge (RFC-003 §5.3) ----------

/// Collect SHA-256 media hashes referenced by a subject's local events:
/// NIP-94 `["x", <sha256>]`, `["sha256", <sha256>]`, and `imeta` "x" pairs.
pub fn collect_media_hashes(relay: &Connection, subject_did: &str) -> Result<Vec<String>, String> {
    let mut stmt = relay
        .prepare("SELECT tags FROM events WHERE pubkey = ?1")
        .map_err(|e| format!("Failed to scan subject events: {}", e))?;
    let rows = stmt
        .query_map(params![subject_did], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query subject events: {}", e))?;

    let mut hashes: Vec<String> = Vec::new();
    for row in rows {
        let tags_json = row.map_err(|e| e.to_string())?;
        let tags: Vec<serde_json::Value> =
            match serde_json::from_str(&tags_json).unwrap_or(serde_json::Value::Array(vec![])) {
                serde_json::Value::Array(v) => v,
                _ => continue,
            };
        for tag in tags {
            let arr = match tag.as_array() {
                Some(a) if !a.is_empty() => a,
                _ => continue,
            };
            let key = arr[0].as_str().unwrap_or("");
            match key {
                "x" | "sha256" => {
                    if let Some(hash) = arr.get(1).and_then(|v| v.as_str()) {
                        if crate::blossom::is_valid_hash(hash) && !hashes.contains(&hash.to_string()) {
                            hashes.push(hash.to_string());
                        }
                    }
                }
                "imeta" => {
                    for pair in arr.iter().skip(1) {
                        let kv = pair.as_str().unwrap_or("");
                        let mut parts = kv.splitn(2, ' ');
                        if parts.next() == Some("x") {
                            if let Some(hash) = parts.next() {
                                if crate::blossom::is_valid_hash(hash)
                                    && !hashes.contains(&hash.to_string())
                                {
                                    hashes.push(hash.to_string());
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    hashes.sort();
    Ok(hashes)
}

/// Two-stage purge cascade (T1 + T2) for a subject DID:
///
/// - **T1 Tombstone:** soft-delete every event authored by the subject in the
///   local relay (`events.deleted = 1`) and record the ids in
///   `tombstoned_events`.
/// - **T2 Media purge:** remove the subject's referenced blobs
///   (`{app_local_data_dir}/blobs/{sha256}`) — the same effect as a Blossom
///   `DELETE /<sha256>` against the local `:9002` store.
///
/// T3 (kind:1605 peer broadcast) is constructed by the IPC layer (it needs
/// the admin L1 signing identity) and reported via `events_broadcast`.
pub fn tombstone_and_purge(
    conn: &Connection,
    relay: Option<&Connection>,
    blobs_dir: &Path,
    subject_did: &str,
    purged_by: &str,
    cascade_media: bool,
) -> Result<PurgeReport, String> {
    let now = now_unix();
    let mut report = PurgeReport {
        subject_did: subject_did.to_string(),
        tombstones: 0,
        blobs_deleted: 0,
        events_broadcast: 0,
        tombstoned_ids: Vec::new(),
    };

    let relay = match relay {
        Some(r) => r,
        None => {
            append_action(
                conn,
                "purge",
                subject_did,
                purged_by,
                &serde_json::json!({ "cascade": "events+media", "tombstones": 0, "blobs_deleted": 0 })
                    .to_string(),
            )?;
            return Ok(report);
        }
    };

    crate::nostr_relay::ensure_deleted_column(relay)?;

    // T1: tombstone authored events.
    let mut stmt = relay
        .prepare("SELECT id FROM events WHERE pubkey = ?1 AND (deleted IS NULL OR deleted = 0)")
        .map_err(|e| format!("Failed to select subject events: {}", e))?;
    let rows = stmt
        .query_map(params![subject_did], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query subject events: {}", e))?;
    let ids: Vec<String> = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

    if !ids.is_empty() {
        relay
            .execute(
                "UPDATE events SET deleted = 1 WHERE pubkey = ?1",
                params![subject_did],
            )
            .map_err(|e| format!("Failed to tombstone subject events: {}", e))?;
        for id in &ids {
            conn.execute(
                "INSERT OR IGNORE INTO tombstoned_events (event_id, subject_did, purged_by, purged_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, subject_did, purged_by, now as i64],
            )
            .map_err(|e| format!("Failed to record tombstone: {}", e))?;
        }
    }
    report.tombstones = ids.len();
    report.tombstoned_ids = ids;

    // T2: purge referenced media from the local Blossom store.
    if cascade_media {
        for hash in collect_media_hashes(relay, subject_did)? {
            let file = blobs_dir.join(&hash);
            match std::fs::metadata(&file) {
                Ok(meta) if meta.is_file() => {
                    if std::fs::remove_file(&file).is_ok() {
                        report.blobs_deleted += 1;
                    }
                }
                _ => {}
            }
        }
    }

    let payload = serde_json::json!({
        "cascade": if cascade_media { "events+media" } else { "events" },
        "tombstones": report.tombstones,
        "blobs_deleted": report.blobs_deleted,
    })
    .to_string();
    append_action(conn, "purge", subject_did, purged_by, &payload)?;
    Ok(report)
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invites;
    use serde_json::Value;

    fn test_mod_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory moderation db");
        init_schema(&conn).expect("moderation schema");
        conn
    }

    fn test_invite_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory invites db");
        invites::init_schema(&conn).expect("invites schema");
        conn
    }

    /// Relay-shaped database replicating `nostr_relay::init_db` DDL so the
    /// purge cascade can be exercised without a live TCP server.
    fn test_relay_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory relay db");
        conn.execute_batch(
            "CREATE TABLE events (
                id TEXT PRIMARY KEY,
                pubkey TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                kind INTEGER NOT NULL,
                tags TEXT NOT NULL,
                content TEXT NOT NULL,
                sig TEXT NOT NULL
            );",
        )
        .expect("relay schema");
        crate::nostr_relay::ensure_deleted_column(&conn).expect("deleted column");
        conn
    }

    fn seed_event(conn: &Connection, id: &str, pubkey: &str, kind: i64, tags: &str) {
        conn.execute(
            "INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'c', 's')",
            params![id, pubkey, 1700000000, kind, tags],
        )
        .expect("seed event");
    }

    #[test]
    fn test_ban_insert_sever_reject_and_ledger() {
        let mut conn = test_mod_conn();
        let evidence = format!("{}", "a".repeat(64));
        let ban_id = insert_ban(
            &mut conn,
            "did:key:z6Mkabuser",
            "spam campaign",
            "did:key:z6Mkadmin",
            "node",
            None,
            Some(&evidence),
        )
        .expect("ban inserted");
        assert!(ban_id > 0);

        // Live socket severance increments the ledger counter.
        let severed = sever_connections(
            &mut conn,
            "did:key:z6Mkabuser",
            2,
            "did:key:z6Mkadmin",
            "spam campaign",
            Some(ban_id),
            "node",
        )
        .expect("sever");
        assert_eq!(severed, 2);

        let bans = list_bans(&conn, false).expect("list bans");
        assert_eq!(bans.len(), 1);
        assert_eq!(bans[0].severed_conns, 2);
        assert_eq!(bans[0].did, "did:key:z6Mkabuser");
        assert_eq!(bans[0].ban_reason, "spam campaign");
        assert!(bans[0].active);

        // The inbound gate rejects the banned identity pre-store.
        let rejected = reject_if_banned(&conn, "did:key:z6Mkabuser");
        assert!(rejected.is_err());
        assert!(rejected.unwrap_err().starts_with("BANNED: spam campaign"));

        // Unrelated identities pass the gate.
        assert!(reject_if_banned(&conn, "did:key:z6Mkclean").is_ok());
    }

    #[test]
    fn test_expired_ban_passes_reject_and_vanishes_from_active_list() {
        let mut conn = test_mod_conn();
        let past = now_unix().saturating_sub(3600);
        insert_ban(
            &mut conn,
            "did:key:z6Mkexpired",
            "temporary",
            "did:key:z6Mkadmin",
            "node",
            Some(past),
            None,
        )
        .expect("ban inserted");
        assert!(reject_if_banned(&conn, "did:key:z6Mkexpired").is_ok());
        assert!(list_bans(&conn, false).expect("active bans").is_empty());
        assert_eq!(list_bans(&conn, true).expect("all bans").len(), 1);
    }

    #[test]
    fn test_unban_soft_deletes_and_keeps_audit_trail() {
        let mut conn = test_mod_conn();
        insert_ban(
            &mut conn,
            "did:key:z6Mkformer",
            "harassment",
            "did:key:z6Mkadmin",
            "node",
            None,
            None,
        )
        .expect("ban inserted");

        soft_delete_ban(&mut conn, "did:key:z6Mkformer", "did:key:z6Mkadmin")
            .expect("unban");

        // Active view empty, full view keeps the soft-deleted row.
        assert!(list_bans(&conn, false).expect("active bans").is_empty());
        let all = list_bans(&conn, true).expect("all bans");
        assert_eq!(all.len(), 1);
        assert!(!all[0].active);
        assert!(all[0].unbanned_at.is_some());

        // Audit trail survives unban AND captures the original reason.
        let actions = list_actions(&conn, 100).expect("actions");
        let kinds: Vec<&str> = actions.iter().map(|a| a.kind.as_str()).collect();
        assert_eq!(kinds, vec!["unban", "ban"]);
        assert!(actions[1].payload.contains("scope"));
        let all = list_bans(&conn, true).expect("all bans");
        assert_eq!(all[0].ban_reason, "harassment", "original reason kept");

        // Unbanning a clean DID fails closed.
        assert!(soft_delete_ban(&mut conn, "did:key:z6Mknever", "did:key:z6Mkadmin").is_err());

        // Re-ban reactivates the same (did, scope) row, preserving UNIQUE.
        insert_ban(
            &mut conn,
            "did:key:z6Mkformer",
            "repeat offender",
            "did:key:z6Mkadmin",
            "node",
            None,
            None,
        )
        .expect("re-ban");
        let active = list_bans(&conn, false).expect("active bans");
        assert_eq!(active.len(), 1);
        assert!(active[0].active);
        assert_eq!(active[0].ban_reason, "repeat offender");
        assert_eq!(list_actions(&conn, 100).expect("actions").len(), 3);
    }

    #[test]
    fn test_authz_gate_uses_admin_role_registry() {
        let conn = test_invite_conn();
        assert!(!is_authorized_admin(&conn, "did:key:z6Mkmember"));
        invites::set_issuer_role_in_db(&conn, "did:key:z6Mkmember", invites::InviteTier::Member)
            .expect("member role");
        assert!(!is_authorized_admin(&conn, "did:key:z6Mkmember"));

        invites::set_issuer_role_in_db(&conn, "did:key:z6Mkadmin", invites::InviteTier::Admin)
            .expect("admin role");
        assert!(is_authorized_admin(&conn, "did:key:z6Mkadmin"));
        // Guests never pass.
        invites::set_issuer_role_in_db(&conn, "did:key:z6Mkguest", invites::InviteTier::Guest)
            .expect("guest role");
        assert!(!is_authorized_admin(&conn, "did:key:z6Mkguest"));
    }

    #[test]
    fn test_termination_frame_shape() {
        let frame: Value = serde_json::from_str(&build_termination_frame(
            "did:key:z6Mkabuser",
            "CSAM ref",
            "did:key:z6Mkadmin",
            42,
        ))
        .expect("frame json");
        assert_eq!(frame["type"], "auth_status");
        assert_eq!(frame["status"], "denied");
        assert_eq!(frame["code"], 403);
        assert_eq!(frame["termination_reason"], "BANNED");
        assert_eq!(frame["ban_id"], 42);
        assert_eq!(frame["ban_reason"], "CSAM ref");
    }

    #[test]
    fn test_tombstone_and_purge_cascade() {
        let conn = test_mod_conn();
        let relay = test_relay_conn();

        let blob_a = "a".repeat(64);
        let blob_b = "b".repeat(64);
        seed_event(
            &relay,
            "evt-1",
            "did:key:z6Mkabuser",
            1,
            &format!(r#"[["x","{0}"]]"#, blob_a),
        );
        seed_event(
            &relay,
            "evt-2",
            "did:key:z6Mkabuser",
            1063,
            &format!(r#"[["imeta","x {0}","m image/png"]]"#, blob_b),
        );
        seed_event(&relay, "evt-3", "did:key:z6Mkother", 1, r#"[["x","c"]]"#);

        let blobs_dir = std::env::temp_dir().join(format!("mod_test_blobs_{}", now_unix()));
        std::fs::create_dir_all(&blobs_dir).expect("blobs dir");
        std::fs::write(blobs_dir.join(&blob_a), b"img-a").expect("blob a");
        std::fs::write(blobs_dir.join(&blob_b), b"img-b").expect("blob b");
        std::fs::write(
            blobs_dir.join("c".repeat(64)),
            b"img-c",
        )
        .expect("blob c");

        let report = tombstone_and_purge(
            &conn,
            Some(&relay),
            &blobs_dir,
            "did:key:z6Mkabuser",
            "did:key:z6Mkadmin",
            true,
        )
        .expect("purge cascade");

        assert_eq!(report.tombstones, 2);
        assert_eq!(report.blobs_deleted, 2, "both subject blobs removed");
        assert_eq!(report.tombstoned_ids, vec!["evt-1", "evt-2"]);

        // Subject events flag deleted; other authors untouched.
        let deleted: Vec<String> = relay
            .prepare("SELECT id FROM events WHERE deleted = 1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(deleted, vec!["evt-1", "evt-2"]);
        let other_deleted: i64 = relay
            .query_row(
                "SELECT COUNT(*) FROM events WHERE pubkey = ?1 AND deleted = 1",
                params!["did:key:z6Mkother"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(other_deleted, 0);

        // Tombstone bookkeeping + audit action recorded.
        let ts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tombstoned_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ts_count, 2);
        let kinds: Vec<String> = conn
            .prepare("SELECT kind FROM moderation_actions")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(kinds, vec!["purge"]);

        // Media cleanup lists: subject blob files gone, bystander blob stays.
        assert!(!blobs_dir.join(&blob_a).exists());
        assert!(!blobs_dir.join(&blob_b).exists());
        assert!(blobs_dir.join("c".repeat(64)).exists());

        let _ = std::fs::remove_dir_all(&blobs_dir);
    }

    #[test]
    fn test_prune_issuer_branch_marks_invite_subtree_revoked() {
        let mut conn = test_invite_conn();
        let now = now_unix() as i64;
        // Three invites by the banned issuer (one claimed, two unredeemed)
        // plus one invite by an unrelated issuer.
        for (i, nonce) in ["n1", "n2", "n3", "n4"].iter().enumerate() {
            let issuer = if i < 3 { "did:key:z6Mkabuser" } else { "did:key:z6Mkother" };
            let child = if i == 0 { "did:key:z6Mkchild" } else { "" };
            conn.execute(
                "INSERT INTO issued_tokens (nonce, token_json, issuer_did, tier, max_uses, uses_count, created_at, expires_at, child_did, revoked_at) \
                 VALUES (?1, '{}', ?2, 'member', 1, 0, ?3, ?3, ?4, NULL)",
                params![nonce, issuer, now, child],
            )
            .expect("seed token");
            conn.execute(
                "INSERT INTO invite_graph (parent_did, child_did, token_nonce, tier_at_issue, created_at, revoked_at, banned_under) \
                 VALUES (?1, ?2, ?3, 'member', ?4, NULL, NULL)",
                params![issuer, child, nonce, now],
            )
            .expect("seed graph edge");
        }

        let pruned =
            invites::prune_issuer_branch(&mut conn, "did:key:z6Mkabuser", "did:key:z6Mkadmin")
                .expect("prune");
        assert_eq!(pruned, 3, "all tokens issued by the banned DID revoked");

        let revoked: Vec<String> = conn
            .prepare("SELECT nonce FROM revoked_nonces ORDER BY nonce")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(revoked, vec!["n1", "n2", "n3"]);

        // Every graph edge under the banned issuer is stamped revoked.
        let graph_revoked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM invite_graph WHERE parent_did = ?1 AND revoked_at IS NOT NULL",
                params!["did:key:z6Mkabuser"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(graph_revoked, 3);

        // The bystander's invite is untouched.
        let other_revoked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM issued_tokens WHERE nonce = 'n4' AND revoked_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(other_revoked, 1);
    }

    #[test]
    fn test_list_members_projects_invite_lineage_and_ban_status() {
        let mut conn = test_mod_conn();
        let invite_conn = test_invite_conn();
        let now = now_unix() as i64;

        // Admin mints (parent-only edge, child empty) then invites childA.
        invite_conn
            .execute(
                "INSERT INTO invite_graph (parent_did, child_did, token_nonce, tier_at_issue, created_at, revoked_at, banned_under) \
                 VALUES ('did:key:z6Mkadmin', '', 'adm', 'admin', ?1, NULL, NULL)",
                params![now - 100],
            )
            .unwrap();
        invite_conn
            .execute(
                "INSERT INTO invite_graph (parent_did, child_did, token_nonce, tier_at_issue, created_at, revoked_at, banned_under) \
                 VALUES ('did:key:z6Mkadmin', 'did:key:z6MkchildA', 'n1', 'member', ?1, NULL, NULL)",
                params![now - 50],
            )
            .unwrap();
        insert_ban(
            &mut conn,
            "did:key:z6MkchildA",
            "spam",
            "did:key:z6Mkadmin",
            "node",
            None,
            None,
        )
        .unwrap();

        let members =
            list_members(&conn, &invite_conn, "did:key:z6Mkadmin", now as u64).unwrap();

        let by_did = |did: &str| members.iter().find(|m| m.did == did).unwrap();
        assert_eq!(by_did("did:key:z6Mkadmin").referrer_did, None);
        assert_eq!(by_did("did:key:z6Mkadmin").status, "active");
        assert_eq!(
            by_did("did:key:z6MkchildA").referrer_did.as_deref(),
            Some("did:key:z6Mkadmin")
        );
        assert_eq!(
            by_did("did:key:z6MkchildA").invite_nonce.as_deref(),
            Some("n1")
        );
        assert_eq!(by_did("did:key:z6MkchildA").status, "banned");
        assert_eq!(by_did("did:key:z6MkchildA").flags, 0);
        assert!(members
            .iter()
            .all(|m| matches!(m.joined_at, Some(_))));
    }
}
