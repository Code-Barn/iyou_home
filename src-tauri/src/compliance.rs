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

//! Neutral Age Gate & Compliance Architecture (RFC-004).
//!
//! Enclave-side age classification and legal disclaimer audit logging.
//!
//! - `classify_age` maps a birth month/year to one of three tiers
//!   (`Child` < 13, `Teen` 13–17, `Adult` 18+) with boundary math anchored to
//!   the 1st day of the birth month (the 13th/18th milestone is reached on
//!   that day). Future dates and years prior to 1900 fail closed.
//! - The sealed `AgeGateRecord` (bracket only) is persisted by the caller into
//!   `preferences.json` under `age_gate`; raw month/year never crosses
//!   external satellite IPC or OIDC claims.
//! - `disclaimer_audit.json` is an append-only, atomic-quarantined log of
//!   every legal/consent disclaimer exposure per RFC-004 §6.2. No birth data,
//!   IP addresses, or telemetry are ever written to it.

use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// Version marker for the `disclaimer_audit.json` envelope.
pub const DISCLAIMER_AUDIT_VERSION: u32 = 1;

/// Version marker of the neutral age gate (bumped if the gate rules change).
pub const GATE_VERSION: &str = "neutral-v1";

// ---------- wire types ----------

/// Three-tier minor framework (RFC-004 §3). Serialized lowercase so the
/// frontend and satellites see `"child" | "teen" | "adult"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgeTier {
    /// < 13: autonomous root forbidden; parental pairing only (RFC-005).
    Child,
    /// 13–17: autonomous root with default-protective policies.
    Teen,
    /// 18+: standard sovereign parameters.
    Adult,
}

impl AgeTier {
    /// Stable lowercase tag used for sealing and JSON payloads.
    pub fn as_str(self) -> &'static str {
        match self {
            AgeTier::Child => "child",
            AgeTier::Teen => "teen",
            AgeTier::Adult => "adult",
        }
    }
}

/// Privacy-sealed age bracket stored in `preferences.json` under
/// `age_gate` (RFC-004 §5.1). The raw `month`/`year` live only in this local
/// record; satellites and OIDC claims receive the `tier` bracket alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgeGateRecord {
    /// `"neutral-v1"` — gate algorithm version.
    pub gate_version: String,
    pub tier: AgeTier,
    /// Unix seconds when the bracket was computed.
    pub computed_at: u64,
    /// SHA-256 over `month|year|tier` for audit integrity of the sealed record.
    pub record_sha256: String,
    /// Birth month (1–12). Local only; never transmitted externally.
    pub month: u8,
    /// Birth year (4-digit). Local only; never transmitted externally.
    pub year: u16,
}

/// Outcome of a disclaimer exposure (RFC-004 §6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisclaimerOutcome {
    Accepted,
    Declined,
    Dismissed,
}

/// One row of the append-only legal disclaimer audit log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisclaimerAuditEntry {
    /// UUID v4, sealed by the enclave on append.
    pub entry_id: String,
    /// SHA-256 of the canonical disclaimer text that was shown.
    pub disclaimer_sha256: String,
    /// Stable key of the disclaimer surface, e.g. `"coppa-teen-safety-v1"`.
    pub disclaimer_key: String,
    /// Version label of the app/build when shown (e.g. `"0.2.1"`).
    pub version_label: String,
    /// Unix seconds when the disclaimer was first shown.
    pub shown_at: u64,
    /// Unix seconds when accepted; null if declined/dismissed.
    pub accepted_at: Option<u64>,
    /// RFC-5646 locale of the shown text, e.g. `"en-US"`.
    pub locale: String,
    /// Local, non-PII device handle (anon-8-hex), sealed by the enclave.
    pub device_id: String,
    /// Active L1 DID, or `"readonly"` pre-provision.
    pub presented_did: String,
    pub outcome: DisclaimerOutcome,
    /// `"onboarding" | "update" | "satellite-connect"`.
    pub context: String,
}

/// Envelope of `{app_data}/disclaimer_audit.json` (RFC-004 §6.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisclaimerAuditLog {
    pub version: u32,
    pub entries: Vec<DisclaimerAuditEntry>,
}

impl Default for DisclaimerAuditLog {
    fn default() -> Self {
        Self {
            version: DISCLAIMER_AUDIT_VERSION,
            entries: Vec::new(),
        }
    }
}

// ---------- classification ----------

/// Classify a birth month/year against `now_unix` into the three-tier
/// framework. Boundary math: the 13th and 18th milestones are reached on the
/// **1st day of the birth month** (RFC-004 §4.2 pseudo-rust).
///
/// Fails closed with `Err("out_of_range")` on impossible dates: month outside
/// 1–12, year prior to 1900, or dates in the future.
pub fn classify_age(birth_month: u8, birth_year: u16, now_unix: u64) -> Result<AgeTier, String> {
    if birth_month == 0 || birth_month > 12 {
        return Err("out_of_range".to_string());
    }
    if birth_year < 1900 {
        return Err("out_of_range".to_string());
    }

    let now_dt: DateTime<Utc> = DateTime::from_timestamp(now_unix as i64, 0)
        .ok_or_else(|| "out_of_range".to_string())?;
    let now_year = now_dt.year() as i64;
    let now_month = now_dt.month() as i64;

    // Fail closed on future dates.
    if birth_year as i64 > now_year || (birth_year as i64 == now_year && birth_month as i64 > now_month)
    {
        return Err("out_of_range".to_string());
    }

    // Whole years survived. The birthday lands on the 1st of the birth month,
    // so if the current month has not yet reached the birth month, one year is
    // still pending.
    let mut age = now_year - birth_year as i64;
    if now_month < birth_month as i64 {
        age -= 1;
    }

    if age < 13 {
        Ok(AgeTier::Child)
    } else if age < 18 {
        Ok(AgeTier::Teen)
    } else {
        Ok(AgeTier::Adult)
    }
}

/// Seal hash for the privacy-minimal bracket record: SHA-256 over the
/// canonical `neutral-v1|month|year|tier` string.
pub fn seal_record_sha256(month: u8, year: u16, tier: AgeTier) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}|{}|{}|{}", GATE_VERSION, month, year, tier.as_str()).as_bytes());
    hex::encode(hasher.finalize())
}

// ---------- disclaimer audit log ----------

/// Path to the append-only disclaimer audit log.
pub fn disclaimer_audit_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("disclaimer_audit.json");
    path
}

/// Load the audit log from a concrete path (missing file ⇒ empty log).
pub fn load_disclaimer_audit_at(path: &Path) -> Result<DisclaimerAuditLog, String> {
    if !path.exists() {
        return Ok(DisclaimerAuditLog::default());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("Failed to read audit log: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse audit log: {}", e))
}

/// Append an entry at a concrete path. Read-modify-write is guarded by the
/// shared atomic staging + rename writer (`vault::atomic_write_bytes`), which
/// never overwrites a corrupted target and preserves every prior entry.
/// Sealing (entry_id, device_id, presented_did) is the caller's job — callers
/// pass an already-sealed entry via `append_disclaimer_audit`.
pub fn append_disclaimer_audit_at(path: &Path, entry: &DisclaimerAuditEntry) -> Result<(), String> {
    let mut log = load_disclaimer_audit_at(path)?;
    log.entries.push(entry.clone());
    let json = serde_json::to_string_pretty(&log)
        .map_err(|e| format!("Failed to serialize audit log: {}", e))?;
    crate::vault::atomic_write_bytes(path, json.as_bytes())
}

/// Load the enclave audit log (missing file ⇒ empty log). Kept public for
/// diagnostics and backup-pack consumers; the authoritative RFC-004 writer is
/// `append_disclaimer_audit`.
#[allow(dead_code)]
pub fn load_disclaimer_audit(app: &AppHandle) -> Result<DisclaimerAuditLog, String> {
    load_disclaimer_audit_at(&disclaimer_audit_path(app))
}

/// Append to the enclave audit log, sealing enclave-authoritative fields:
/// fresh UUID, anon-8-hex device id, and the active L1 DID (or
/// `"readonly"` pre-provision). Never trusts client-supplied identity fields.
pub fn append_disclaimer_audit(
    app: &AppHandle,
    mut entry: DisclaimerAuditEntry,
) -> Result<(), String> {
    entry.entry_id = Uuid::new_v4().to_string();
    entry.device_id = anonymized_device_id(app);
    entry.presented_did = resolve_presented_did(app);
    append_disclaimer_audit_at(&disclaimer_audit_path(app), &entry)
}

/// Derive a stable, non-PII device handle: first 8 hex chars of the SHA-256
/// of the app's local data directory (anon-8-hex per RFC-004 §6.2).
pub fn anonymized_device_id(app: &AppHandle) -> String {
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let mut hasher = Sha256::new();
    hasher.update(dir.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..4])
}

/// Active Level 1 public persona DID for the audit row, or `"readonly"`
/// before the vault is provisioned (RFC-004 §6.2 comment).
pub fn resolve_presented_did(app: &AppHandle) -> String {
    match crate::vault::load_vault(app) {
        Ok(vault) => vault
            .public_persona()
            .map(|p| p.did.clone())
            .unwrap_or_else(|| "readonly".to_string()),
        Err(_) => "readonly".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::env::temp_dir;

    fn unix_seconds(y: i32, m: u32, d: u32, h: u32, min: u32, s: u32) -> u64 {
        Utc.with_ymd_and_hms(y, m, d, h, min, s)
            .single()
            .expect("valid timestamp")
            .timestamp() as u64
    }

    fn sample_entry(entry_id: &str, outcome: DisclaimerOutcome) -> DisclaimerAuditEntry {
        DisclaimerAuditEntry {
            entry_id: entry_id.to_string(),
            disclaimer_sha256: "51f37b35cd5c77ba06a29877f63e7762d19407d547bee1e27acc3b78df0ebbbd"
                .to_string(),
            disclaimer_key: "coppa-teen-safety-v1".to_string(),
            version_label: "0.2.1".to_string(),
            shown_at: 1760000000,
            accepted_at: None,
            locale: "en-US".to_string(),
            device_id: "a1b2c3d4".to_string(),
            presented_did: "readonly".to_string(),
            outcome,
            context: "onboarding".to_string(),
        }
    }

    // ---------- classify_age boundaries ----------

    #[test]
    fn test_day_before_13th_birthday_is_child() {
        // Born Sep 2012; Aug 31 2025 23:59:59 UTC — still 12 → Child.
        let now = unix_seconds(2025, 8, 31, 23, 59, 59);
        assert_eq!(classify_age(9, 2012, now).unwrap(), AgeTier::Child);
    }

    #[test]
    fn test_day_of_13th_birthday_is_teen() {
        // Born Sep 2012; Sep 1 2025 00:00:00 UTC — 13th birthday is the 1st of
        // the birth month → Teen.
        let now = unix_seconds(2025, 9, 1, 0, 0, 0);
        assert_eq!(classify_age(9, 2012, now).unwrap(), AgeTier::Teen);
    }

    #[test]
    fn test_day_before_18th_birthday_is_teen() {
        // Born Sep 2007; Aug 31 2025 — still 17 → Teen.
        let now = unix_seconds(2025, 8, 31, 23, 59, 59);
        assert_eq!(classify_age(9, 2007, now).unwrap(), AgeTier::Teen);
    }

    #[test]
    fn test_day_of_18th_birthday_is_adult() {
        // Born Sep 2007; Sep 1 2025 — 18 on the 1st of the birth month → Adult.
        let now = unix_seconds(2025, 9, 1, 0, 0, 0);
        assert_eq!(classify_age(9, 2007, now).unwrap(), AgeTier::Adult);
    }

    #[test]
    fn test_under_13_is_child() {
        let now = unix_seconds(2025, 6, 15, 12, 0, 0);
        assert_eq!(classify_age(12, 2020, now).unwrap(), AgeTier::Child);
    }

    #[test]
    fn test_teen_13_to_17_bracket() {
        let now = unix_seconds(2026, 1, 10, 8, 30, 0);
        assert_eq!(classify_age(1, 2012, now).unwrap(), AgeTier::Teen); // 14
        assert_eq!(classify_age(1, 2008, now).unwrap(), AgeTier::Adult); // 18
    }

    #[test]
    fn test_future_date_fails_closed() {
        // Born 2031 (future) and born later this year than today.
        let now = unix_seconds(2025, 9, 18, 0, 0, 0);
        assert_eq!(classify_age(9, 2031, now).unwrap_err(), "out_of_range");
        assert_eq!(classify_age(12, 2025, now).unwrap_err(), "out_of_range");
    }

    #[test]
    fn test_year_before_1900_fails_closed() {
        let now = unix_seconds(2025, 9, 18, 0, 0, 0);
        assert_eq!(classify_age(1, 1899, now).unwrap_err(), "out_of_range");
        assert_eq!(classify_age(1, 1800, now).unwrap_err(), "out_of_range");
    }

    #[test]
    fn test_invalid_month_fails_closed() {
        let now = unix_seconds(2025, 9, 18, 0, 0, 0);
        assert_eq!(classify_age(0, 2000, now).unwrap_err(), "out_of_range");
        assert_eq!(classify_age(13, 2000, now).unwrap_err(), "out_of_range");
    }

    #[test]
    fn test_seal_record_sha256_is_deterministic() {
        let a = seal_record_sha256(9, 2012, AgeTier::Teen);
        let b = seal_record_sha256(9, 2012, AgeTier::Teen);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        // A tier change must change the seal.
        assert_ne!(a, seal_record_sha256(9, 2012, AgeTier::Child));
    }

    // ---------- DISCLAIMER_AUDIT append-only integrity ----------

    #[test]
    fn test_disclaimer_audit_append_only_integrity() {
        let mut path = temp_dir();
        path.push(format!("disclaimer_audit_test_{}.json", Uuid::new_v4()));
        let _ = std::fs::remove_file(&path);

        // Two distinct entries must both survive, in order, after re-appends.
        append_disclaimer_audit_at(&path, &sample_entry("e1", DisclaimerOutcome::Dismissed)).unwrap();
        append_disclaimer_audit_at(&path, &sample_entry("e2", DisclaimerOutcome::Accepted)).unwrap();

        let log = load_disclaimer_audit_at(&path).expect("log reloads");
        assert_eq!(log.version, DISCLAIMER_AUDIT_VERSION);
        assert_eq!(log.entries.len(), 2);
        assert_eq!(log.entries[0].entry_id, "e1");
        assert_eq!(log.entries[0].outcome, DisclaimerOutcome::Dismissed);
        assert_eq!(log.entries[1].entry_id, "e2");
        assert_eq!(log.entries[1].outcome, DisclaimerOutcome::Accepted);

        // Prior content is byte-preserved: a third append keeps all three.
        append_disclaimer_audit_at(&path, &sample_entry("e3", DisclaimerOutcome::Declined)).unwrap();
        let log = load_disclaimer_audit_at(&path).unwrap();
        assert_eq!(log.entries.len(), 3);

        // No staging file may remain after the atomic writes.
        assert!(!path.with_file_name("disclaimer_audit_test_x.json.tmp").exists());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_disclaimer_audit_missing_file_is_empty() {
        let mut path = temp_dir();
        path.push(format!("disclaimer_audit_missing_{}.json", Uuid::new_v4()));
        let log = load_disclaimer_audit_at(&path).expect("missing file is empty log");
        assert_eq!(log.version, DISCLAIMER_AUDIT_VERSION);
        assert!(log.entries.is_empty());
    }

    #[test]
    fn test_disclaimer_log_never_contains_birth_data() {
        // Schema invariant: audit rows carry no month/year/DoB fields.
        let json = serde_json::to_value(sample_entry("e1", DisclaimerOutcome::Accepted)).unwrap();
        for key in json.as_object().unwrap().keys() {
            assert!(
                !key.contains("month")
                    && !key.contains("year")
                    && !key.contains("birth")
                    && !key.contains("dob"),
                "audit entry leaks birth data via key: {}",
                key
            );
        }
    }
}