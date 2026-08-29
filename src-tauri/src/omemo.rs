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

//! Native-enclave OMEMO device registry and pre-key bundle store.
//!
//! The enclave keeps one OMEMO device per app install. Identity material
//! (X25519 identity key, Ed25519 signing key, signed + one-time prekeys) is
//! persisted locally at `{app_data}/omemo_store.json` and never crosses the
//! UI — only public keys and bundle envelopes do. `publish_bundle` records
//! the current signed-prekey bundle under this machine's Level 1 JID so the
//! companion web client (and a peer device on the same private network) can
//! `fetch_peer_bundle` it for DH session setup.

use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use ed25519_dalek::{
    Signature as EdSignature, Signer as _, SigningKey, Verifier as _, VerifyingKey,
};
use rand::rngs::OsRng;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager as _};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::vault;

/// Number of fresh one-time prekeys minted each time the local bundle is
/// (re)published.
pub const OMEMO_ONETIME_POOL: u32 = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmemoLocalDevice {
    pub device_id: u32,
    pub identity_public_hex: String,
    pub signing_public_hex: String,
    pub signed_prekey_public_hex: String,
    pub signed_prekey_creation_ms: u64,
    // Secret material — only ever written to the local store file.
    pub identity_secret_b64: String,
    pub signing_secret_b64: String,
    pub signed_prekey_secret_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmemoPrekey {
    pub id: u32,
    pub public_hex: String,
    #[serde(default)]
    pub secret_b64: String,
    #[serde(default)]
    pub consumed: bool,
}

/// A single publishable bundle stamped with its JID.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredBundle {
    pub jid: String,
    pub bundle_json: String,
    pub published_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmemoStore {
    pub schema_version: u32,
    pub local_device: Option<OmemoLocalDevice>,
    #[serde(default)]
    pub local_prekeys: Vec<OmemoPrekey>,
    #[serde(default)]
    pub published_bundles: Vec<StoredBundle>,
}

impl Default for OmemoStore {
    fn default() -> Self {
        Self {
            schema_version: 1,
            local_device: None,
            local_prekeys: Vec::new(),
            published_bundles: Vec::new(),
        }
    }
}

/// Lightweight device summary returned to the frontend for a peer JID.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmemoDeviceInfo {
    pub device_id: u32,
    pub identity_public_hex: String,
    pub signed_prekey_public_hex: String,
    pub active: bool,
}

// ---------- Helpers ----------

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_bytes32(hex_str: &str) -> Result<[u8; 32], String> {
    let decoded = hex::decode(hex_str).map_err(|e| format!("Invalid hex: {}", e))?;
    decoded
        .try_into()
        .map_err(|_| "Expected 32-byte key".to_string())
}

// ---------- Persistence ----------

pub fn get_omemo_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("omemo_store.json");
    path
}

/// Missing file is a normal first-run state. A corrupt file is quarantined
/// (mirroring contacts.json / pairing.json semantics) and surfaced as an
/// error — never silently regenerated.
pub fn load_omemo_store(app: &AppHandle) -> Result<OmemoStore, String> {
    load_omemo_store_from_path(&get_omemo_path(app))
}

pub fn load_omemo_store_from_path(path: &Path) -> Result<OmemoStore, String> {
    if !path.exists() {
        return Ok(OmemoStore::default());
    }
    let raw = fs::read(path).map_err(|e| format!("Failed to read omemo store: {}", e))?;
    let parse_err = |detail: String| -> String {
        match vault::quarantine_corrupt_vault(path) {
            Ok(backup) => format!(
                "OMEMO store corrupt (quarantined to {}): {}",
                backup.display(),
                detail
            ),
            Err(q) => format!("OMEMO store corrupt (quarantine failed: {}): {}", q, detail),
        }
    };
    serde_json::from_slice::<OmemoStore>(&raw)
        .map_err(|e| parse_err(format!("Failed to parse omemo store: {}", e)))
}

pub fn save_omemo_store(app: &AppHandle, store: &OmemoStore) -> Result<(), String> {
    let json = serde_json::to_string(store)
        .map_err(|e| format!("OMEMO store serialization error: {}", e))?;
    vault::atomic_write_bytes(&get_omemo_path(app), json.as_bytes())
}

// ---------- Device generation ----------

/// Generate a fresh OMEMO device (identity X25519 key, Ed25519 signing key,
/// signed prekey). Pure — no I/O.
pub fn generate_omemo_device() -> OmemoLocalDevice {
    let mut identity_secret = [0u8; 32];
    OsRng.fill_bytes(&mut identity_secret);
    let identity = StaticSecret::from(identity_secret);

    let signing = SigningKey::generate(&mut OsRng);

    let mut spk_secret = [0u8; 32];
    OsRng.fill_bytes(&mut spk_secret);
    let signed_prekey = StaticSecret::from(spk_secret);

    // Device ids must be non-zero and collision-resistant.
    let mut device_id = OsRng.next_u32();
    if device_id == 0 {
        device_id = 1;
    }

    OmemoLocalDevice {
        device_id,
        identity_public_hex: hex::encode(PublicKey::from(&identity).as_bytes()),
        signing_public_hex: hex::encode(signing.verifying_key().to_bytes()),
        signed_prekey_public_hex: hex::encode(PublicKey::from(&signed_prekey).as_bytes()),
        signed_prekey_creation_ms: now_ms(),
        identity_secret_b64: base64.encode(identity_secret),
        signing_secret_b64: base64.encode(signing.to_bytes()),
        signed_prekey_secret_b64: base64.encode(signed_prekey.to_bytes()),
    }
}

/// Mint `count` unused one-time prekeys, appending to the local pool.
pub fn mint_onetime_prekeys(count: u32, store: &mut OmemoStore) -> Vec<OmemoPrekey> {
    let first_id = store
        .local_prekeys
        .iter()
        .map(|p| p.id)
        .max()
        .unwrap_or(0)
        + 1;
    let mut fresh = Vec::with_capacity(count as usize);
    for next_id in first_id..first_id + count {
        let mut secret = [0u8; 32];
        OsRng.fill_bytes(&mut secret);
        let key = StaticSecret::from(secret);
        fresh.push(OmemoPrekey {
            id: next_id,
            public_hex: hex::encode(PublicKey::from(&key).as_bytes()),
            secret_b64: base64.encode(secret),
            consumed: false,
        });
    }
    store.local_prekeys.extend(fresh.iter().cloned());
    fresh
}

fn unused_prekeys(store: &OmemoStore) -> Vec<OmemoPrekey> {
    store
        .local_prekeys
        .iter()
        .filter(|p| !p.consumed)
        .cloned()
        .collect()
}

// ---------- Bundle signing ----------

/// Deterministic message of the public bundle fields, signed by the device's
/// Ed25519 signing key. Both sides of a connected peer can reproduce it.
pub fn bundle_signing_message(
    device_id: u32,
    identity_public_hex: &str,
    signed_prekey_public_hex: &str,
    signing_public_hex: &str,
    onetime: &[OmemoPrekey],
) -> String {
    let onetime_ids = onetime
        .iter()
        .map(|p| format!("{}:{}", p.id, p.public_hex))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "iyou-home/omemo-bundle/v1|{}|{}|{}|{}|{}",
        device_id, identity_public_hex, signed_prekey_public_hex, signing_public_hex, onetime_ids
    )
}

/// Sign the given onetime-prekey pool's bundle message with the device's
/// Ed25519 signing key.
pub fn sign_bundle(device: &OmemoLocalDevice, onetime: &[OmemoPrekey]) -> Result<String, String> {
    let secret = base64
        .decode(&device.signing_secret_b64)
        .map_err(|e| format!("Invalid signing secret: {}", e))?;
    let signing: [u8; 32] = secret
        .try_into()
        .map_err(|_| "Signing secret must be 32 bytes".to_string())?;
    let key = SigningKey::from_bytes(&signing);
    let message = bundle_signing_message(
        device.device_id,
        &device.identity_public_hex,
        &device.signed_prekey_public_hex,
        &device.signing_public_hex,
        onetime,
    );
    let sig = key.sign(message.as_bytes());
    Ok(hex::encode(sig.to_bytes()))
}

fn parse_signature_hex(hex_str: &str) -> Result<[u8; 64], String> {
    let decoded =
        hex::decode(hex_str).map_err(|e| format!("Invalid signature hex: {}", e))?;
    if decoded.len() != 64 {
        return Err(format!("Expected 64-byte signature, got {}", decoded.len()));
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&decoded);
    Ok(out)
}

/// Verify a bundle signature against the advertised signing key.
pub fn verify_bundle_signature(
    signing_public_hex: &str,
    message: &str,
    signature_hex: &str,
) -> Result<(), String> {
    let pubkey = parse_bytes32(signing_public_hex)?;
    let verifying = VerifyingKey::from_bytes(&pubkey)
        .map_err(|e| format!("Invalid signing public key: {}", e))?;
    let sig_bytes = parse_signature_hex(signature_hex)?;
    let signature = EdSignature::from_bytes(&sig_bytes);
    verifying
        .verify(message.as_bytes(), &signature)
        .map_err(|_| "Bundle signature verification failed".to_string())
}

// ---------- Public envelope ----------

fn build_local_bundle_in_memory(store: &mut OmemoStore) -> Result<String, String> {
    if store.local_device.is_none() {
        store.local_device = Some(generate_omemo_device());
        mint_onetime_prekeys(OMEMO_ONETIME_POOL, store);
    }
    let device = store
        .local_device
        .as_ref()
        .ok_or("OMEMO device unavailable".to_string())?;
    let onetime = unused_prekeys(store);
    let signature = sign_bundle(device, &onetime)?;
    let envelope = serde_json::json!({
        "device_id": device.device_id,
        "identity_public_hex": device.identity_public_hex,
        "signed_prekey_public_hex": device.signed_prekey_public_hex,
        "signing_public_hex": device.signing_public_hex,
        "one_time_prekeys": onetime.iter().map(|prekey| serde_json::json!({
            "id": prekey.id,
            "public_hex": prekey.public_hex,
        })).collect::<Vec<_>>(),
        "signature": signature,
    });
    serde_json::to_string_pretty(&envelope)
        .map_err(|e| format!("Failed to serialize bundle: {}", e))
}

// ---------- Bundle registry (in-memory core + AppHandle wrappers) ----------

/// Validate `bundle_json` and upsert it into `store` under `jid` (in-memory).
pub fn publish_bundle_in_memory(
    store: &mut OmemoStore,
    jid: &str,
    bundle_json: &str,
) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(bundle_json)
        .map_err(|e| format!("Bundle is not valid JSON: {}", e))?;

    let device_id = value
        .get("device_id")
        .and_then(|v| v.as_u64())
        .ok_or("Missing numeric device_id")?;
    let identity_hex = value
        .get("identity_public_hex")
        .and_then(|v| v.as_str())
        .ok_or("Missing identity_public_hex")?;
    let signed_spk_hex = value
        .get("signed_prekey_public_hex")
        .and_then(|v| v.as_str())
        .ok_or("Missing signed_prekey_public_hex")?;
    let signing_hex = value
        .get("signing_public_hex")
        .and_then(|v| v.as_str())
        .ok_or("Missing signing_public_hex")?;
    let signature = value
        .get("signature")
        .and_then(|v| v.as_str())
        .ok_or("Missing signature")?;

    if device_id == 0 {
        return Err("Device id must be non-zero".to_string());
    }
    parse_bytes32(identity_hex)?;
    parse_bytes32(signed_spk_hex)?;
    parse_bytes32(signing_hex)?;

    // Rebuild the signing message from the bundle's own onetime list so the
    // envelope signature is self-verifying.
    let mut onetime = Vec::new();
    if let Some(ots) = value.get("one_time_prekeys").and_then(|v| v.as_array()) {
        for ot in ots {
            let id = ot
                .get("id")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32)
                .ok_or("One-time prekey missing id")?;
            let public_hex = ot
                .get("public_hex")
                .and_then(|v| v.as_str())
                .ok_or("One-time prekey missing public_hex")?;
            parse_bytes32(public_hex)?;
            onetime.push(OmemoPrekey {
                id,
                public_hex: public_hex.to_string(),
                secret_b64: String::new(),
                consumed: false,
            });
        }
    }
    let message = bundle_signing_message(
        device_id as u32,
        identity_hex,
        signed_spk_hex,
        signing_hex,
        &onetime,
    );
    verify_bundle_signature(signing_hex, &message, signature)?;

    if let Some(existing) = store
        .published_bundles
        .iter_mut()
        .find(|b| b.jid == jid)
    {
        existing.bundle_json = bundle_json.to_string();
        existing.published_at_ms = now_ms();
    } else {
        store.published_bundles.push(StoredBundle {
            jid: jid.to_string(),
            bundle_json: bundle_json.to_string(),
            published_at_ms: now_ms(),
        });
    }
    Ok(())
}

/// Generate (once) the enclave device, sign its bundle, and record it under
/// this machine's own JID. Returns the serialized bundle.
pub fn publish_local_bundle(app: &AppHandle, jid: &str) -> Result<String, String> {
    let mut store = load_omemo_store(app)?;
    let bundle = build_local_bundle_in_memory(&mut store)?;
    publish_bundle_in_memory(&mut store, jid, &bundle)?;
    save_omemo_store(app, &store)?;
    Ok(bundle)
}

/// Return `Some(bundle_json)` for a peer JID if it has published on this
/// enclave, else `None`.
pub fn fetch_bundle_for(app: &AppHandle, jid: &str) -> Result<Option<String>, String> {
    let store = load_omemo_store(app)?;
    Ok(store
        .published_bundles
        .iter()
        .find(|b| b.jid == jid)
        .map(|b| b.bundle_json.clone()))
}

/// Device summary for a peer JID from its published bundle.
pub fn list_peer_devices(app: &AppHandle, jid: &str) -> Result<Vec<OmemoDeviceInfo>, String> {
    let Some(bundle_json) = fetch_bundle_for(app, jid)? else {
        return Ok(Vec::new());
    };
    let value: serde_json::Value = serde_json::from_str(&bundle_json)
        .map_err(|e| format!("Stored bundle unparseable: {}", e))?;
    let device_id = value.get("device_id").and_then(|v| v.as_u64()).unwrap_or(0);
    let identity = value
        .get("identity_public_hex")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let spk = value
        .get("signed_prekey_public_hex")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(vec![OmemoDeviceInfo {
        device_id: device_id as u32,
        identity_public_hex: identity,
        signed_prekey_public_hex: spk,
        active: true,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_distinct_devices_with_nonzero_ids() {
        let a = generate_omemo_device();
        let b = generate_omemo_device();
        assert_ne!(a.device_id, 0);
        assert_ne!(a.device_id, b.device_id);
        assert_eq!(a.identity_public_hex.len(), 64);
        assert_eq!(a.signed_prekey_public_hex.len(), 64);
        assert_eq!(a.signing_public_hex.len(), 64);
    }

    #[test]
    fn bundle_signature_round_trips_and_fails_when_tampered() {
        let mut store = OmemoStore::default();
        let bundle = build_local_bundle_in_memory(&mut store).unwrap();
        let value: serde_json::Value = serde_json::from_str(&bundle).unwrap();
        let device = store.local_device.as_ref().unwrap();

        let mut onetime = Vec::new();
        for ot in value["one_time_prekeys"].as_array().unwrap() {
            onetime.push(OmemoPrekey {
                id: ot["id"].as_u64().unwrap() as u32,
                public_hex: ot["public_hex"].as_str().unwrap().to_string(),
                secret_b64: String::new(),
                consumed: false,
            });
        }
        let message = bundle_signing_message(
            device.device_id,
            &device.identity_public_hex,
            &device.signed_prekey_public_hex,
            &device.signing_public_hex,
            &onetime,
        );
        verify_bundle_signature(
            &device.signing_public_hex,
            &message,
            value["signature"].as_str().unwrap(),
        )
        .unwrap();

        let tampered = format!("{}x", message);
        assert!(
            verify_bundle_signature(
                &device.signing_public_hex,
                &tampered,
                value["signature"].as_str().unwrap()
            )
            .is_err()
        );
    }

    #[test]
    fn mint_pools_unused_onetime_keys() {
        let mut store = OmemoStore {
            local_device: Some(generate_omemo_device()),
            ..OmemoStore::default()
        };
        mint_onetime_prekeys(4, &mut store);
        mint_onetime_prekeys(2, &mut store);
        assert_eq!(store.local_prekeys.len(), 6);
        assert_eq!(unused_prekeys(&store).len(), 6);
        store.local_prekeys[0].consumed = true;
        assert_eq!(unused_prekeys(&store).len(), 5);
    }

    #[test]
    fn store_round_trips_through_json() {
        let mut store = OmemoStore {
            local_device: Some(generate_omemo_device()),
            ..OmemoStore::default()
        };
        mint_onetime_prekeys(OMEMO_ONETIME_POOL, &mut store);

        let round_tripped: OmemoStore =
            serde_json::from_str(&serde_json::to_string(&store).unwrap()).unwrap();
        let orig = store.local_device.as_ref().unwrap();
        let got = round_tripped.local_device.as_ref().unwrap();
        assert_eq!(got.device_id, orig.device_id);
        assert_eq!(got.identity_public_hex, orig.identity_public_hex);
        assert_eq!(got.signing_public_hex, orig.signing_public_hex);
        assert_eq!(round_tripped.local_prekeys.len(), OMEMO_ONETIME_POOL as usize);
    }

    #[test]
    fn publish_rejects_malformed_or_tampered_bundles() {
        let mut store = OmemoStore::default();
        let err = publish_bundle_in_memory(&mut store, "x@127.0.0.1", "{not json").unwrap_err();
        assert!(err.contains("JSON"));

        // A genuine bundle with its identity key swapped out: the signature no
        // longer covers the payload, so signing verification must reject it.
        let mut store2 = OmemoStore::default();
        let bundle = build_local_bundle_in_memory(&mut store2).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&bundle).unwrap();
        let other = generate_omemo_device();
        value["identity_public_hex"] = serde_json::Value::String(other.identity_public_hex);
        let tampered = serde_json::to_string(&value).unwrap();

        let err = publish_bundle_in_memory(&mut store, "y@127.0.0.1", &tampered).unwrap_err();
        assert!(err.contains("verification failed"));
        assert!(store.published_bundles.is_empty());
    }

    #[test]
    fn publish_accepts_own_bundle_and_lists_devices() {
        let mut store = OmemoStore::default();
        let bundle = build_local_bundle_in_memory(&mut store).unwrap();

        publish_bundle_in_memory(&mut store, "abc123@127.0.0.1", &bundle).unwrap();
        publish_bundle_in_memory(&mut store, "other@127.0.0.1", &bundle).unwrap();
        // Re-publish under the same JID should upsert, not duplicate.
        publish_bundle_in_memory(&mut store, "abc123@127.0.0.1", &bundle).unwrap();

        assert_eq!(store.published_bundles.len(), 2);
        let found = store
            .published_bundles
            .iter()
            .find(|b| b.jid == "abc123@127.0.0.1")
            .unwrap();
        assert_eq!(found.bundle_json, bundle);
    }

    #[test]
    fn quarantine_helper_path_extension_is_sane() {
        // The store filename used by the app.
        let name = PathBuf::from("omemo_store.json");
        assert_eq!(name.extension().unwrap(), "json");
    }
}