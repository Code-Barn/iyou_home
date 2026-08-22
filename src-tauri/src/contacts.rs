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

//! Contact Enclave — locally stored peer records for the Peer Trust &
//! Alias Lens.
//!
//! Deliberately separate from `VaultStore`: bridge alias queries load only
//! `contacts.json`, so un-scoped WebSocket callers can never reach root
//! seed or key material.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::vault;

/// Upper bound on keys per RESOLVE_PEER_ALIASES query (harvesting guard).
pub const MAX_RESOLVE_KEYS: usize = 256;

// ---------- Schema ----------

/// Peer trust tier. Wire/storage values are the variant names verbatim:
/// "Level0", "Level0_5", "Level1".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrustLevel {
    #[serde(alias = "level0", alias = "Level0")]
    Level0,
    #[serde(alias = "level0_5", alias = "level0.5", alias = "Level0_5", alias = "Level0.5")]
    Level0_5,
    #[serde(alias = "level1", alias = "Level1")]
    Level1,
}

impl Default for TrustLevel {
    fn default() -> Self {
        TrustLevel::Level1
    }
}

impl TrustLevel {
    pub fn badge(&self) -> &'static str {
        match self {
            TrustLevel::Level0 => "Inner Circle",
            TrustLevel::Level0_5 => "Trusted Alliance",
            TrustLevel::Level1 => "Peer",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerContact {
    /// Canonical identity: primary DID or 64-hex Nostr pubkey.
    pub peer_id: String,
    pub display_name: String,
    #[serde(default)]
    pub trust_level: TrustLevel,
    /// Bound Level 2 sock DIDs, burner nostr hex keys, external handles.
    #[serde(default)]
    pub disclosed_aliases: Vec<String>,
    /// Optional raw signed VC / presentation backing the introduction.
    #[serde(default)]
    pub attestation_receipt: Option<String>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContactStore {
    pub contacts: Vec<PeerContact>,
}

// ---------- Normalization ----------

/// Normalize an identity token for storage and lookup. Trims whitespace;
/// lowercases ONLY pure 64-char hex tokens (Nostr x-only keys are case
/// insensitive). DID identifiers use case-sensitive base58/multibase and
/// must be matched verbatim — never blanket-lowercased.
pub fn normalize_key(token: &str) -> String {
    let t = token.trim();
    if t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        t.to_ascii_lowercase()
    } else {
        t.to_string()
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------- Persistence ----------

fn get_contacts_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("contacts.json");
    path
}

pub fn load_contact_store(app: &AppHandle) -> Result<ContactStore, String> {
    load_contact_store_from_path(&get_contacts_path(app))
}

/// Missing file is a normal first-run state: empty store. A corrupt file is
/// quarantined to `contacts.json.corrupt_<ts>.bak` and surfaced as an error
/// — never silently regenerated.
pub fn load_contact_store_from_path(path: &Path) -> Result<ContactStore, String> {
    if !path.exists() {
        return Ok(ContactStore::default());
    }

    let raw = fs::read(path).map_err(|e| format!("Failed to read contacts: {}", e))?;

    let parse_err = |detail: String| -> String {
        match vault::quarantine_corrupt_vault(path) {
            Ok(backup) => format!(
                "Contacts corrupt (quarantined to {}): {}",
                backup.display(),
                detail
            ),
            Err(q) => format!("Contacts corrupt (quarantine failed: {}): {}", q, detail),
        }
    };

    let text = match String::from_utf8(raw) {
        Ok(t) => t,
        Err(_) => return Err(parse_err("File is not valid UTF-8".to_string())),
    };

    serde_json::from_str::<ContactStore>(&text)
        .map_err(|e| parse_err(format!("Failed to parse contacts: {}", e)))
}

pub fn save_contact_store(app: &AppHandle, store: &ContactStore) -> Result<(), String> {
    save_contact_store_to_path(&get_contacts_path(app), store)
}

pub fn save_contact_store_to_path(path: &Path, store: &ContactStore) -> Result<(), String> {
    let json =
        serde_json::to_string(store).map_err(|e| format!("Serialization error: {}", e))?;
    vault::atomic_write_bytes(path, json.as_bytes())
}

// ---------- Mutation helpers ----------

/// Validate + upsert a contact by `peer_id`. Preserves `created_at` of an
/// existing record, stamps `updated_at`, normalizes ids/aliases and removes
/// duplicate aliases. Returns the stored record.
pub fn upsert_contact(
    store: &mut ContactStore,
    mut contact: PeerContact,
) -> Result<PeerContact, String> {
    contact.peer_id = normalize_key(&contact.peer_id);
    if contact.peer_id.is_empty() {
        return Err("peer_id must not be empty".to_string());
    }
    if contact.display_name.trim().is_empty() {
        return Err("display_name must not be empty".to_string());
    }

    // Normalize + dedupe aliases while preserving disclosure order.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut aliases = Vec::with_capacity(contact.disclosed_aliases.len());
    for alias in contact.disclosed_aliases.drain(..) {
        let normalized = normalize_key(&alias);
        if !normalized.is_empty() && seen.insert(normalized.clone()) {
            aliases.push(normalized);
        }
    }
    // The canonical id itself should never appear as its own alias.
    aliases.retain(|a| a != &contact.peer_id);
    contact.disclosed_aliases = aliases;

    let now = unix_now();
    if let Some(existing) = store
        .contacts
        .iter_mut()
        .find(|c| c.peer_id == contact.peer_id)
    {
        contact.created_at = existing.created_at;
        contact.updated_at = now;
        *existing = contact.clone();
    } else {
        contact.created_at = now;
        contact.updated_at = now;
        store.contacts.push(contact.clone());
    }

    Ok(contact)
}

/// Delete a contact by canonical `peer_id`. Errors when absent so callers
/// can distinguish a no-op from success.
pub fn remove_contact(store: &mut ContactStore, peer_id: &str) -> Result<(), String> {
    let pid = normalize_key(peer_id);
    let before = store.contacts.len();
    store.contacts.retain(|c| c.peer_id != pid);
    if store.contacts.len() == before {
        return Err(format!("Contact '{}' not found", pid));
    }
    Ok(())
}

// ---------- Alias Resolution Engine ----------

/// Privacy-safe projection returned to bridge / IPC consumers. Never
/// includes peer_id, alias lists, receipts, or timestamps.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedPeer {
    pub nickname: String,
    pub trust_level: TrustLevel,
    pub badge: &'static str,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AliasResolution {
    /// Queried key → minimal public projection.
    pub matches: BTreeMap<String, ResolvedPeer>,
    /// Queried keys with no local contact hit (echoed verbatim, trimmed).
    pub unknown: Vec<String>,
}

/// Exact-match lookup against `peer_id ∪ disclosed_aliases`. Pure function;
/// no IO, trivially unit-testable.
pub fn resolve_peer_aliases_in_store(
    store: &ContactStore,
    queries: &[String],
) -> AliasResolution {
    let mut index: HashMap<String, usize> = HashMap::new();
    for (i, contact) in store.contacts.iter().enumerate() {
        index
            .entry(normalize_key(&contact.peer_id))
            .or_insert(i);
        for alias in &contact.disclosed_aliases {
            index.entry(normalize_key(alias)).or_insert(i);
        }
    }

    let mut out = AliasResolution::default();
    for query in queries {
        let key = normalize_key(query);
        match index.get(&key) {
            Some(&i) => {
                let contact = &store.contacts[i];
                out.matches.insert(
                    key,
                    ResolvedPeer {
                        nickname: contact.display_name.clone(),
                        trust_level: contact.trust_level,
                        badge: contact.trust_level.badge(),
                    },
                );
            }
            None => out.unknown.push(key),
        }
    }
    out
}

/// Canonical wire frame for both the WebSocket bridge and Tauri IPC.
pub fn resolution_json(store: &ContactStore, queries: &[String]) -> serde_json::Value {
    let resolution = resolve_peer_aliases_in_store(store, queries);
    serde_json::json!({
        "type": "peer_aliases_resolved",
        "matches": resolution.matches,
        "unknown": resolution.unknown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    fn alice() -> PeerContact {
        PeerContact {
            peer_id: "did:key:z6MkAliceMain".to_string(),
            display_name: "Alice".to_string(),
            trust_level: TrustLevel::Level0,
            disclosed_aliases: vec![
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
                "did:key:z6MkAliceSock".to_string(),
                "@alice:example.org".to_string(),
            ],
            attestation_receipt: None,
            created_at: 1000,
            updated_at: 1000,
        }
    }

    fn bob() -> PeerContact {
        PeerContact {
            peer_id: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
                .to_string(),
            display_name: "Bob".to_string(),
            trust_level: TrustLevel::Level0_5,
            disclosed_aliases: vec![],
            attestation_receipt: None,
            created_at: 2000,
            updated_at: 2000,
        }
    }

    #[test]
    fn test_trust_level_badges_and_defaults() {
        assert_eq!(TrustLevel::default(), TrustLevel::Level1);
        assert_eq!(TrustLevel::Level0.badge(), "Inner Circle");
        assert_eq!(TrustLevel::Level0_5.badge(), "Trusted Alliance");
        assert_eq!(TrustLevel::Level1.badge(), "Peer");

        // Wire values are variant names verbatim per protocol spec.
        let json = serde_json::to_value(TrustLevel::Level0_5).unwrap();
        assert_eq!(json, "Level0_5");
    }

    #[test]
    fn test_alias_resolution_matches_primary_and_disclosed() {
        let store = ContactStore {
            contacts: vec![alice(), bob()],
        };

        let resolution = resolve_peer_aliases_in_store(
            &store,
            &[
                "did:key:z6MkAliceMain".to_string(),
                // Disclosed alias (hex form, mixed case) resolves too.
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
                "did:key:z6MkAliceSock".to_string(),
                "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_string(),
            ],
        );

        assert_eq!(resolution.matches.len(), 4);
        assert!(resolution.unknown.is_empty());

        let via_alias = resolution
            .matches
            .get("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .expect("Disclosed hex alias should resolve");
        assert_eq!(via_alias.nickname, "Alice");
        assert_eq!(via_alias.trust_level, TrustLevel::Level0);
        assert_eq!(via_alias.badge, "Inner Circle");

        let bob_hit = resolution.matches.values().find(|p| p.nickname == "Bob");
        assert_eq!(bob_hit.map(|p| p.badge), Some("Trusted Alliance"));
    }

    #[test]
    fn test_resolution_normalizes_hex_case_and_reports_unknown() {
        let store = ContactStore { contacts: vec![bob()] };

        let resolution = resolve_peer_aliases_in_store(
            &store,
            &[
                // Hex queries are case-insensitive.
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbBBBB".to_string(),
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_string(),
            ],
        );

        assert_eq!(resolution.matches.len(), 1);
        assert!(resolution.matches.contains_key(
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ));
        assert_eq!(resolution.unknown.len(), 1);

        // DID identifiers are case-sensitive: a case-mangled DID must NOT match.
        let mangled = resolve_peer_aliases_in_store(
            &store,
            &["did:key:Z6MKALICEMAIN".to_string()],
        );
        assert!(mangled.matches.is_empty());
        assert_eq!(mangled.unknown.len(), 1);

        // Wire frame shape check.
        let frame = resolution_json(&store, &[
            "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB".to_string(),
        ]);
        assert_eq!(frame["type"], "peer_aliases_resolved");
        assert_eq!(frame["matches"].as_object().unwrap().len(), 1);
        let entry = frame["matches"]
            .get("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            .unwrap();
        assert_eq!(entry["nickname"], "Bob");
        assert_eq!(entry["trust_level"], "Level0_5");
        assert_eq!(entry["badge"], "Trusted Alliance");
        // Privacy projection: no internal fields leak into the wire frame.
        assert!(entry.get("peer_id").is_none());
        assert!(entry.get("disclosed_aliases").is_none());
        assert!(frame.get("contacts").is_none());
    }

    #[test]
    fn test_contact_round_trip_persistence() {
        let dir = temp_dir();
        let path = dir.join(format!(
            "test_contacts_roundtrip_{}.json",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);

        // Missing file → empty store, no error.
        let fresh = load_contact_store_from_path(&path).expect("Missing store loads empty");
        assert!(fresh.contacts.is_empty());

        let store = ContactStore {
            contacts: vec![alice(), bob()],
        };
        save_contact_store_to_path(&path, &store).expect("Should save contacts");

        let loaded = load_contact_store_from_path(&path).expect("Should reload contacts");
        assert_eq!(loaded.contacts.len(), 2);
        assert_eq!(loaded.contacts[0].peer_id, alice().peer_id);
        assert_eq!(loaded.contacts[0].disclosed_aliases.len(), 3);
        assert_eq!(loaded.contacts[1].trust_level, TrustLevel::Level0_5);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn test_upsert_preserves_created_at_and_dedupes_aliases() {
        let mut store = ContactStore { contacts: vec![alice()] };
        let original_created = store.contacts[0].created_at;

        let mut updated = alice();
        updated.display_name = "Alice Prime".to_string();
        updated.trust_level = TrustLevel::Level1;
        // Duplicates, whitespace padding, self-reference, and empties all collapse.
        updated.disclosed_aliases = vec![
            "  did:key:z6MkAliceSock  ".to_string(),
            "did:key:z6MkAliceSock".to_string(),
            "did:key:z6MkNewSock".to_string(),
            "did:key:z6MkAliceMain".to_string(),
            "   ".to_string(),
        ];

        let stored = upsert_contact(&mut store, updated).expect("Upsert should succeed");
        assert_eq!(store.contacts.len(), 1, "Upsert must replace, not append");
        assert_eq!(stored.display_name, "Alice Prime");
        assert_eq!(stored.trust_level, TrustLevel::Level1);
        assert_eq!(stored.created_at, original_created, "created_at preserved");
        assert!(stored.updated_at >= stored.created_at);
        assert_eq!(
            stored.disclosed_aliases,
            vec!["did:key:z6MkAliceSock".to_string(), "did:key:z6MkNewSock".to_string()]
        );

        assert!(upsert_contact(&mut store, alice_with_empty_id()).is_err());
        assert!(upsert_contact(&mut store, alice_with_blank_name()).is_err());
    }

    fn alice_with_empty_id() -> PeerContact {
        let mut c = alice();
        c.peer_id = "   ".to_string();
        c
    }

    fn alice_with_blank_name() -> PeerContact {
        let mut c = alice();
        c.display_name = "  ".to_string();
        c
    }

    #[test]
    fn test_remove_contact_errors_on_missing() {
        // Seed through the real write path so peer_id is normalized
        // exactly as it would be in production.
        let mut store = ContactStore::default();
        upsert_contact(&mut store, bob()).expect("Seed contact");

        remove_contact(&mut store, "did:key:zUnknown").expect_err("Missing contact must error");
        assert_eq!(store.contacts.len(), 1);

        remove_contact(&mut store, &bob().peer_id).expect("Existing contact should delete");
        assert!(store.contacts.is_empty());
    }

    #[test]
    fn test_corrupt_contacts_quarantines_and_errors() {
        let dir = temp_dir();
        let path = dir.join(format!(
            "test_contacts_corrupt_{}.json",
            std::process::id()
        ));
        let garbage: &[u8] = &[0x00, 0xFF, 0xDE, 0xAD];
        fs::write(&path, garbage).expect("Should write garbage");

        let err = load_contact_store_from_path(&path)
            .err()
            .expect("Corrupt store must fail");
        assert!(err.contains("Contacts corrupt"), "Got: {}", err);
        assert!(err.contains("quarantined"), "Got: {}", err);

        assert!(!path.exists(), "Original corrupt file must be renamed away");

        let backups = vault::existing_corrupt_backups(&dir, path.file_name().unwrap().to_str().unwrap());
        assert!(!backups.is_empty(), "Quarantine backup must exist");
        for backup in backups {
            let _ = fs::remove_file(backup);
        }
    }
}
