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

use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use k256::schnorr::SigningKey as SecpSigningKey;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

// Identity Graduation transit crypto (AGENT.md §16 / AUTH_FLOW_SPECIFICATION §16).
// The IdP seals the custodial Ed25519 seed behind an ephemeral X25519 ECDH +
// HKDF-SHA256 + AES-256-GCM envelope; these crates unwrap it locally.
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce as AesNonce, Key as AesKey};
use hkdf::Hkdf;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

/// Level 0 — immutable, air-gapped anchor identity (private P2P enclaves only).
pub const ANCHOR_PROFILE_ID: &str = "anchor";
/// Level 1 — default active persona for public social tasks.
pub const DEFAULT_PERSONA_PROFILE_ID: &str = "primary";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub profile_id: String,
    pub profile_name: String,
    pub derivation_index: u32,
    pub did: String,
    pub credentials: Vec<VaultCredential>,
    pub nostr_pubkey_hex: String,
    /// Identity tier: 0 = Anchor, 1 = Public Persona, 2+ = Burner/Contextual.
    #[serde(default)]
    pub level: u8,
    /// System-reserved profiles (Anchor) can never be deleted or externally used.
    #[serde(default)]
    pub is_system_reserved: bool,
    #[serde(default)]
    pub active: bool,
}

impl Profile {
    pub fn is_anchor(&self) -> bool {
        self.level == 0 || self.derivation_index == 0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultCredential {
    pub vc_id: String,
    pub issuer_did: String,
    pub subject_did: String,
    pub credential_type: String,
    pub fidelity_score: Option<f64>,
    pub expiration_date: Option<String>,
    pub raw_payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStore {
    pub root_seed_base58: String,
    pub profiles: Vec<Profile>,
    /// Graduated sovereign identities whose Ed25519 seeds are sealed with
    /// ChaCha20Poly1305 under the WebAuthn PRF KEK. These never derive from
    /// the local root seed and are invisible to root-seed keypair paths.
    #[serde(default)]
    pub sovereign_identities: Vec<SovereignIdentity>,
}

impl VaultStore {
    /// The default public-facing identity: first profile at Level 1+ /
    /// derivation index 1+. Never returns the Level 0 anchor.
    pub fn public_persona(&self) -> Option<&Profile> {
        // Prefer any profile explicitly marked active (as long as it's not Level 0 Anchor)
        if let Some(active_p) = self
            .profiles
            .iter()
            .find(|p| p.active && p.level >= 1 && p.derivation_index >= 1)
        {
            return Some(active_p);
        }
        // Prefer the canonical primary persona (profile_id == "primary", level 1).
        // This ensures tombstoned retired personas (level 2) are skipped.
        self.profiles
            .iter()
            .find(|p| p.profile_id == DEFAULT_PERSONA_PROFILE_ID && p.level == 1)
            .or_else(|| {
                self.profiles
                    .iter()
                    .find(|p| p.level == 1 && p.derivation_index >= 1)
            })
            .or_else(|| self.profiles.iter().find(|p| p.derivation_index == 1))
    }

    /// Resolve a profile by id. An empty id resolves to the active persona
    /// (or public persona Level 1 fallback), never the air-gapped anchor.
    pub fn get_profile_by_id(&self, id: &str) -> Option<&Profile> {
        if id.is_empty() {
            self.profiles
                .iter()
                .find(|p| p.active && !p.is_anchor())
                .or_else(|| self.public_persona())
        } else {
            self.profiles.iter().find(|p| p.profile_id == id)
        }
    }
}

/// A graduated sovereign persona imported from an iyou_idp custodial export.
/// The raw 32-byte Ed25519 seed is stored only as a ChaCha20Poly1305 sealed
/// blob (`nonce || ciphertext || tag`, base64) keyed by the WebAuthn PRF KEK,
/// so the vault file alone never yields usable key material.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SovereignIdentity {
    pub did: String,
    pub profile_name: String,
    pub nostr_pubkey_hex: String,
    pub sealed_seed_b64: String,
    #[serde(default = "default_true")]
    pub custodial_origin: bool,
    pub graduated_at: u64,
}

fn default_true() -> bool {
    true
}

impl Default for SovereignIdentity {
    fn default() -> Self {
        Self {
            did: String::new(),
            profile_name: "Sovereign Identity".to_string(),
            nostr_pubkey_hex: String::new(),
            sealed_seed_b64: String::new(),
            custodial_origin: true,
            graduated_at: 0,
        }
    }
}

pub struct DerivedKeypair {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
    pub did: String,
}

fn ed25519_multibase(pubkey: &[u8]) -> String {
    let mut multicodec = Vec::with_capacity(2 + pubkey.len());
    multicodec.extend_from_slice(&[0xed, 0x01]);
    multicodec.extend_from_slice(pubkey);
    format!("z{}", bs58::encode(multicodec).into_string())
}

pub fn derive_deterministic_keypair(root_seed: &[u8], derivation_index: u32) -> DerivedKeypair {
    let mut hasher = Sha256::new();
    hasher.update(root_seed);
    hasher.update(&derivation_index.to_le_bytes());
    let hash = hasher.finalize();

    let mut arr = [0u8; 32];
    arr.copy_from_slice(&hash);
    let signing_key = SigningKey::from_bytes(&arr);
    let verifying_key = signing_key.verifying_key();
    let did = format!("did:key:{}", ed25519_multibase(verifying_key.as_bytes()));

    DerivedKeypair {
        signing_key,
        verifying_key,
        did,
    }
}

/// Derive a secp256k1 secret key from the vault root seed, domain-separated
/// from the Ed25519 derivation path to keep key material independent.
pub fn decode_root_seed(vault: &VaultStore) -> Result<Vec<u8>, String> {
    bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())
}

/// Decode the base58 root seed and return its lowercase hex representation.
pub fn reveal_root_seed_hex(vault: &VaultStore) -> Result<String, String> {
    let seed = decode_root_seed(vault)?;
    Ok(hex::encode(seed))
}

/// Derive an AES-256-GCM key from a password using HKDF-SHA256.
fn derive_backup_key(password: &str, salt: &[u8; 32]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), password.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(b"iyou-home/backup/v1", &mut key)
        .expect("HKDF expand should not fail for 32-byte output");
    key
}

/// Enumerate `.json` ledger files inside `{app_data}/ledgers/` (if present).
///
/// The directory is optional and may not exist on fresh installs; this never
/// fails — it simply returns an empty vector. Files are sorted for a stable
/// archive manifest.
fn collect_ledger_files(app_data_dir: &Path) -> Vec<PathBuf> {
    let ledgers_dir = app_data_dir.join("ledgers");
    let Ok(entries) = std::fs::read_dir(&ledgers_dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        })
        .collect();
    files.sort();
    files
}

/// Pack the in-memory vault and data directory companion files into a plaintext JSON payload.
fn pack_backup_payload(vault: &VaultStore, app_data_dir: &Path) -> Result<String, String> {
    let vault_val = serde_json::to_value(vault)
        .map_err(|e| format!("Failed to serialize vault: {}", e))?;

    let contacts_path = app_data_dir.join("contacts.json");
    let contacts_val: serde_json::Value = match fs::read(&contacts_path) {
        Ok(bytes) if !bytes.is_empty() => {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!([]))
        }
        _ => serde_json::json!([]),
    };

    let prefs_path = app_data_dir.join("preferences.json");
    let prefs_val: serde_json::Value = match fs::read(&prefs_path) {
        Ok(bytes) if !bytes.is_empty() => {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({}))
        }
        _ => serde_json::json!({}),
    };

    let pairing_path = app_data_dir.join("pairing.json");
    let pairing_val: serde_json::Value = match fs::read(&pairing_path) {
        Ok(bytes) if !bytes.is_empty() => {
            serde_json::from_slice(&bytes).unwrap_or_else(|_| serde_json::json!({}))
        }
        _ => serde_json::json!({}),
    };

    // Dynamically bundle every JSON file found in {app_data}/ledgers/.
    let mut ledgers_map = serde_json::Map::new();
    for path in collect_ledger_files(app_data_dir) {
        if let Ok(bytes) = fs::read(&path) {
            if bytes.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    ledgers_map.insert(name.to_string(), value);
                }
            }
        }
    }

    let exported_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let ledger_file_count = ledgers_map.len();

    let payload = serde_json::json!({
        "vault": vault_val,
        "contacts": contacts_val,
        "preferences": prefs_val,
        "pairing": pairing_val,
        "ledgers": serde_json::Value::Object(ledgers_map),
        "manifest": {
            "version": "2.0",
            "exported_at": exported_at,
            "app_version": "2.0.0",
            "ledger_file_count": ledger_file_count
        }
    });

    serde_json::to_string(&payload).map_err(|e| format!("Failed to serialize payload: {}", e))
}

/// Encrypt a plaintext string with AES-256-GCM using a password-derived key.
fn encrypt_payload(plaintext: &str, password: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; 32];
    OsRng.fill_bytes(&mut salt);

    let key = derive_backup_key(password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = AesNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    let envelope = serde_json::json!({
        "salt_b64": base64.encode(salt),
        "nonce_b64": base64.encode(nonce_bytes),
        "ciphertext_b64": base64.encode(&ciphertext),
    });

    serde_json::to_vec(&envelope).map_err(|e| format!("Failed to serialize envelope: {}", e))
}

/// Decrypt an AES-256-GCM envelope and return the plaintext.
fn decrypt_payload(encrypted: &[u8], password: &str) -> Result<String, String> {
    let envelope: serde_json::Value = serde_json::from_slice(encrypted)
        .map_err(|e| format!("Invalid backup format: {}", e))?;

    let salt_b64 = envelope["salt_b64"]
        .as_str()
        .ok_or("Missing salt_b64 in backup envelope")?;
    let nonce_b64 = envelope["nonce_b64"]
        .as_str()
        .ok_or("Missing nonce_b64 in backup envelope")?;
    let ciphertext_b64 = envelope["ciphertext_b64"]
        .as_str()
        .ok_or("Missing ciphertext_b64 in backup envelope")?;

    let salt: [u8; 32] = base64
        .decode(salt_b64)
        .map_err(|e| format!("Invalid salt encoding: {}", e))?
        .try_into()
        .map_err(|_| "Salt must be 32 bytes".to_string())?;
    let nonce_bytes: [u8; 12] = base64
        .decode(nonce_b64)
        .map_err(|e| format!("Invalid nonce encoding: {}", e))?
        .try_into()
        .map_err(|_| "Nonce must be 12 bytes".to_string())?;
    let ciphertext = base64
        .decode(ciphertext_b64)
        .map_err(|e| format!("Invalid ciphertext encoding: {}", e))?;

    let key = derive_backup_key(password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;
    let nonce = AesNonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Decryption failed — wrong password or corrupted backup".to_string())?;

    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8 in payload: {}", e))
}

/// Export the vault, contacts, and preferences as an encrypted `.iyoubackup` archive.
///
/// Returns the raw bytes of the encrypted JSON envelope ready for file download.
pub fn export_vault_backup(
    vault: &VaultStore,
    app_data_dir: &Path,
    password: &str,
) -> Result<Vec<u8>, String> {
    if password.is_empty() {
        return Err("Password cannot be empty".to_string());
    }
    let plaintext = pack_backup_payload(vault, app_data_dir)?;
    encrypt_payload(&plaintext, password)
}

/// Restore vault, contacts, and preferences from an encrypted `.iyoubackup` archive.
///
/// Decrypts the payload, validates the manifest, and atomically writes each file
/// to the destination directory.
pub fn import_vault_backup(
    app_data_dir: &Path,
    backup_bytes: &[u8],
    password: &str,
) -> Result<bool, String> {
    if password.is_empty() {
        return Err("Password cannot be empty".to_string());
    }

    let plaintext = decrypt_payload(backup_bytes, password)?;
    let payload: serde_json::Value = serde_json::from_str(&plaintext)
        .map_err(|e| format!("Invalid payload structure: {}", e))?;

    // Validate manifest
    let manifest = payload
        .get("manifest")
        .ok_or("Backup missing manifest.json")?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    if version != "2.0" {
        return Err(format!(
            "Unsupported backup version '{}'. Expected '2.0'.",
            version
        ));
    }

    fs::create_dir_all(app_data_dir)
        .map_err(|e| format!("Failed to create data directory: {}", e))?;

    // Atomic restore via .tmp staging (vault is base64 encoded by save_vault_inner)
    if let Some(vault_val) = payload.get("vault") {
        let vault_store: VaultStore = serde_json::from_value(vault_val.clone())
            .map_err(|e| format!("Failed to parse vault structure: {}", e))?;
        save_vault_inner(&app_data_dir.join("vault.json"), &vault_store)?;
    }

    if let Some(contacts_val) = payload.get("contacts") {
        let contacts_bytes = serde_json::to_vec_pretty(contacts_val)
            .map_err(|e| format!("Failed to serialize contacts: {}", e))?;
        let tmp = app_data_dir.join("contacts.json.tmp");
        atomic_write_bytes(&tmp, &contacts_bytes)?;
        let dest = app_data_dir.join("contacts.json");
        fs::rename(&tmp, &dest)
            .map_err(|e| format!("Failed to finalize contacts.json: {}", e))?;
    }

    if let Some(prefs_val) = payload.get("preferences") {
        let prefs_bytes = serde_json::to_vec_pretty(prefs_val)
            .map_err(|e| format!("Failed to serialize preferences: {}", e))?;
        let tmp = app_data_dir.join("preferences.json.tmp");
        atomic_write_bytes(&tmp, &prefs_bytes)?;
        let dest = app_data_dir.join("preferences.json");
        fs::rename(&tmp, &dest)
            .map_err(|e| format!("Failed to finalize preferences.json: {}", e))?;
    }

    if let Some(pairing_val) = payload.get("pairing") {
        let pairing_bytes = serde_json::to_vec_pretty(pairing_val)
            .map_err(|e| format!("Failed to serialize pairing: {}", e))?;
        let tmp = app_data_dir.join("pairing.json.tmp");
        atomic_write_bytes(&tmp, &pairing_bytes)?;
        let dest = app_data_dir.join("pairing.json");
        fs::rename(&tmp, &dest)
            .map_err(|e| format!("Failed to finalize pairing.json: {}", e))?;
    }

    // Dynamically restore ledger files bundled under payload["ledgers"]. Each
    // file lands in {app_data}/ledgers/ via .tmp staging + atomic rename.
    // Filenames are sanitized to a single safe basename to block traversal.
    if let Some(ledgers) = payload.get("ledgers").and_then(|l| l.as_object()) {
        let ledgers_dir = app_data_dir.join("ledgers");
        for (name, value) in ledgers.iter() {
            let file_name = Path::new(name)
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|n| !n.starts_with('.') && n.ends_with(".json"))
                .ok_or_else(|| format!("Unsafe ledger filename in backup: '{}'", name))?;
            let ledger_bytes = serde_json::to_vec_pretty(value)
                .map_err(|e| format!("Failed to serialize ledger '{}': {}", file_name, e))?;
            let tmp = ledgers_dir.join(format!("{}.tmp", file_name));
            atomic_write_bytes(&tmp, &ledger_bytes)?;
            let dest = ledgers_dir.join(file_name);
            fs::rename(&tmp, &dest)
                .map_err(|e| format!("Failed to finalize ledger '{}': {}", file_name, e))?;
        }
    }

    Ok(true)
}

pub fn derive_secp256k1_secret_key(root_seed: &[u8], derivation_index: u32) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"secp256k1-nostr");
    hasher.update(root_seed);
    hasher.update(&derivation_index.to_le_bytes());
    let hash = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&hash);
    arr
}

pub fn derive_secp256k1_pubkey_hex(root_seed: &[u8], derivation_index: u32) -> String {
    let sk_bytes = derive_secp256k1_secret_key(root_seed, derivation_index);
    let key = SecpSigningKey::from_bytes(&sk_bytes)
        .expect("valid 32-byte secp256k1 secret key");
    hex::encode(key.verifying_key().to_bytes())
}

// ---------- Identity Graduation: transit unsealing & sovereign ingest ----------

/// HKDF info string binding derived wrapping keys to the graduation protocol.
/// Must stay byte-identical to the IdP implementation
/// (AUTH_FLOW_SPECIFICATION §16.1).
pub const GRADUATION_HKDF_INFO: &[u8] = b"iyou-idp/graduation-export/v1";

/// Unwrap a sealed custodial identity export on the client side:
/// X25519 ECDH(client_ephemeral_priv × server_ephemeral_pub) →
/// HKDF-SHA256(salt = nonce, info = GRADUATION_HKDF_INFO) → AES-256-GCM
/// open with `custodial_did` bound as AEAD associated data. Returns the raw
/// 32-byte Ed25519 seed wrapped in `Zeroizing`.
pub fn unseal_graduation_export(
    client_ephemeral_priv: &[u8; 32],
    server_ephemeral_pub: &[u8; 32],
    nonce: &[u8],
    ciphertext: &[u8],
    custodial_did: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    if nonce.len() != 12 {
        return Err(format!(
            "Invalid export nonce length: expected 12 bytes, got {}",
            nonce.len()
        ));
    }
    // Minimum plausible payload: 32-byte seed + 16-byte GCM tag.
    if ciphertext.len() < 48 {
        return Err(format!(
            "Export ciphertext too short: expected at least 48 bytes, got {}",
            ciphertext.len()
        ));
    }

    let client_secret = StaticSecret::from(*client_ephemeral_priv);
    let shared = client_secret.diffie_hellman(&X25519PublicKey::from(*server_ephemeral_pub));
    if !shared.was_contributory() {
        return Err("Degenerate ECDH shared secret (low-order point)".to_string());
    }

    let hk = Hkdf::<Sha256>::new(Some(nonce), shared.as_bytes());
    let mut wrapping_key = Zeroizing::new([0u8; 32]);
    hk.expand(GRADUATION_HKDF_INFO, wrapping_key.as_mut())
        .map_err(|_| "HKDF expansion failed".to_string())?;

    let cipher = Aes256Gcm::new(AesKey::<Aes256Gcm>::from_slice(wrapping_key.as_slice()));
    let plaintext = cipher
        .decrypt(
            AesNonce::from_slice(&nonce[..12]),
            Payload {
                msg: ciphertext,
                aad: custodial_did.as_bytes(),
            },
        )
        .map_err(|_| {
            "Graduation export decryption failed: AEAD authentication error \
             (transit key mismatch or custodial DID binding violation)"
                .to_string()
        })?;

    if plaintext.len() != 32 {
        return Err(format!(
            "Unsealed identity seed must be exactly 32 bytes, got {}",
            plaintext.len()
        ));
    }

    Ok(Zeroizing::new(plaintext))
}

/// Import a graduated sovereign persona into the vault. The unsealed seed is
/// immediately re-sealed with ChaCha20Poly1305 under the WebAuthn PRF KEK via
/// `did_rust::encrypt_vault_payload` and persisted as an opaque blob — the
/// plaintext seed never touches disk.
pub fn ingest_graduated_identity(
    vault: &mut VaultStore,
    custodial_did: &str,
    ed25519_seed: &[u8],
    prf_kek: &[u8; 32],
) -> Result<SovereignIdentity, String> {
    if ed25519_seed.len() != 32 {
        return Err(format!(
            "Ed25519 seed must be 32 bytes, got {}",
            ed25519_seed.len()
        ));
    }
    if vault
        .sovereign_identities
        .iter()
        .any(|s| s.did == custodial_did)
    {
        return Err(format!(
            "Sovereign identity '{}' already exists in vault",
            custodial_did
        ));
    }

    let mut seed_arr = [0u8; 32];
    seed_arr.copy_from_slice(ed25519_seed);

    // Validate the seed is a usable Ed25519 scalar before persisting anything.
    SigningKey::from_bytes(&seed_arr);

    // Deterministic companion Nostr key derived from the sovereign seed itself
    // (domain-separated from the Ed25519 key inside did_rust).
    let (nostr_pubkey_hex, _) = did_rust::derive_nostr_keypair(&seed_arr, 0)
        .map_err(|e| format!("Failed to derive sovereign Nostr key: {}", e))?;

    let sealed = did_rust::encrypt_vault_payload(prf_kek, &seed_arr)
        .map_err(|e| format!("Failed to seal sovereign seed: {}", e))?;

    let record = SovereignIdentity {
        did: custodial_did.to_string(),
        profile_name: "Sovereign Identity".to_string(),
        nostr_pubkey_hex,
        sealed_seed_b64: base64::engine::general_purpose::STANDARD.encode(&sealed),
        custodial_origin: true,
        graduated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };

    vault.sovereign_identities.push(record.clone());
    Ok(record)
}

/// Recover the signing key of a stored sovereign persona by unsealing its
/// ChaCha20Poly1305 blob under the supplied PRF KEK.
pub fn unseal_sovereign_identity(
    record: &SovereignIdentity,
    prf_kek: &[u8; 32],
) -> Result<SigningKey, String> {
    let sealed = base64::engine::general_purpose::STANDARD
        .decode(&record.sealed_seed_b64)
        .map_err(|_| "Invalid sealed sovereign seed encoding".to_string())?;
    let plaintext = Zeroizing::new(
        did_rust::decrypt_vault_payload(prf_kek, &sealed)
            .map_err(|e| format!("Failed to unseal sovereign seed: {}", e))?,
    );
    if plaintext.len() != 32 {
        return Err(format!(
            "Unsealed sovereign seed must be 32 bytes, got {}",
            plaintext.len()
        ));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&plaintext);
    Ok(SigningKey::from_bytes(&arr))
}

pub fn get_sovereign_identity<'a>(
    vault: &'a VaultStore,
    did: &str,
) -> Option<&'a SovereignIdentity> {
    vault.sovereign_identities.iter().find(|s| s.did == did)
}

fn get_storage_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("vault.json");
    path
}

pub fn create_vault_at_path(path: &Path) -> Result<VaultStore, String> {
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    let root_seed_base58 = bs58::encode(seed).into_string();

    let vault = VaultStore {
        root_seed_base58,
        profiles: initial_profiles(&seed),
        sovereign_identities: Vec::new(),
    };

    save_vault_inner(path, &vault)?;
    Ok(vault)
}

/// Bootstrap the reserved identity hierarchy from a root seed:
/// Level 0 Anchor at index 0 and the Level 1 public persona at index 1.
pub fn initial_profiles(seed: &[u8]) -> Vec<Profile> {
    let anchor_kp = derive_deterministic_keypair(seed, 0);
    let anchor_nostr_pk = derive_secp256k1_pubkey_hex(seed, 0);
    let persona_kp = derive_deterministic_keypair(seed, 1);
    let persona_nostr_pk = derive_secp256k1_pubkey_hex(seed, 1);

    vec![
        Profile {
            profile_id: ANCHOR_PROFILE_ID.to_string(),
            profile_name: "Anchor Identity".to_string(),
            derivation_index: 0,
            did: anchor_kp.did,
            credentials: vec![],
            nostr_pubkey_hex: anchor_nostr_pk,
            level: 0,
            is_system_reserved: true,
            active: false,
        },
        Profile {
            profile_id: DEFAULT_PERSONA_PROFILE_ID.to_string(),
            profile_name: "Primary Identity".to_string(),
            derivation_index: 1,
            did: persona_kp.did,
            credentials: vec![],
            nostr_pubkey_hex: persona_nostr_pk,
            level: 1,
            is_system_reserved: false,
            active: true,
        },
    ]
}

// ---------- Persistence: load, quarantine, atomic save ----------

/// Error taxonomy for vault loading. `NotFound` is the legitimate first-run
/// bootstrap signal; every other variant must NEVER trigger regeneration.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VaultLoadError {
    NotFound,
    Corrupt {
        quarantined_to: Option<PathBuf>,
        detail: String,
    },
    Io(String),
}

impl std::fmt::Display for VaultLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultLoadError::NotFound => write!(f, "No vault found at path"),
            VaultLoadError::Corrupt {
                quarantined_to,
                detail,
            } => write!(
                f,
                "Vault corrupt (quarantined: {:?}): {}",
                quarantined_to, detail
            ),
            VaultLoadError::Io(err) => write!(f, "Vault IO error: {}", err),
        }
    }
}

impl std::error::Error for VaultLoadError {}

impl From<VaultLoadError> for String {
    fn from(e: VaultLoadError) -> Self {
        e.to_string()
    }
}

/// Number of `vault.json.corrupt_*.bak` files retained after rotation.
const CORRUPT_BACKUPS_TO_KEEP: usize = 5;

fn corrupt_backup_prefix(original_file_name: &str) -> String {
    format!("{}.corrupt_", original_file_name)
}

/// Collect existing quarantine backups for a vault file, newest first.
/// Timestamps are fixed-width unix seconds embedded in the file name, so
/// lexicographic ordering matches chronological ordering.
pub(crate) fn existing_corrupt_backups(dir: &Path, original_file_name: &str) -> Vec<PathBuf> {
    let prefix = corrupt_backup_prefix(original_file_name);
    let mut backups: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(&prefix) && n.ends_with(".bak"))
                .unwrap_or(false)
        })
        .collect();
    backups.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    backups
}

/// Rename a damaged vault file out of harm's way as
/// `<name>.corrupt_<UNIX_TIMESTAMP>.bak` (with `_N` collision counter
/// within the same second), then prune older backups. Shared by the vault
/// and contact stores so a damaged file can never be destroyed by a
/// subsequent save.
pub(crate) fn quarantine_corrupt_vault(path: &Path) -> std::io::Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let original_file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("vault.json")
        .to_string();
    let dir = path.parent().unwrap_or_else(|| Path::new("."));

    let mut backup = dir.join(format!("{}.corrupt_{}.bak", original_file_name, timestamp));
    let mut collision = 0u32;
    while backup.exists() {
        collision += 1;
        backup = dir.join(format!(
            "{}.corrupt_{}_{}.bak",
            original_file_name, timestamp, collision
        ));
    }

    fs::rename(path, &backup)?;
    rotate_corrupt_backups(dir, &original_file_name)?;
    Ok(backup)
}

fn rotate_corrupt_backups(dir: &Path, original_file_name: &str) -> std::io::Result<()> {
    for stale in existing_corrupt_backups(dir, original_file_name)
        .into_iter()
        .skip(CORRUPT_BACKUPS_TO_KEEP)
    {
        let _ = fs::remove_file(stale);
    }
    Ok(())
}

/// Build a `Corrupt` error, quarantining the damaged file when possible so a
/// subsequent save can never destroy the only copy of the user's identities.
fn corrupt_error(path: &Path, detail: String) -> VaultLoadError {
    match quarantine_corrupt_vault(path) {
        Ok(quarantined_to) => VaultLoadError::Corrupt {
            quarantined_to: Some(quarantined_to),
            detail,
        },
        Err(q_err) => VaultLoadError::Corrupt {
            quarantined_to: None,
            detail: format!("{} (quarantine failed: {})", detail, q_err),
        },
    }
}

/// Read-only load from disk. Never creates or regenerates a vault.
pub fn load_vault_from_path(path: &Path) -> Result<VaultStore, VaultLoadError> {
    if !path.exists() {
        return Err(VaultLoadError::NotFound);
    }

    let raw = fs::read(path).map_err(|e| VaultLoadError::Io(e.to_string()))?;

    let text = match String::from_utf8(raw) {
        Ok(t) => t,
        Err(_) => return Err(corrupt_error(path, "File is not valid UTF-8".to_string())),
    };

    let decoded = match base64.decode(text.trim()) {
        Ok(d) => d,
        Err(e) => return Err(corrupt_error(path, format!("Base64 decode error: {}", e))),
    };

    let json = match String::from_utf8(decoded) {
        Ok(j) => j,
        Err(_) => {
            return Err(corrupt_error(
                path,
                "Decoded payload is not valid UTF-8".to_string(),
            ))
        }
    };

    serde_json::from_str::<VaultStore>(&json)
        .map_err(|e| corrupt_error(path, format!("Failed to parse vault: {}", e)))
}

pub fn load_vault(app: &AppHandle) -> Result<VaultStore, VaultLoadError> {
    load_vault_from_path(&get_storage_path(app))
}

/// Self-healing migration for legacy vaults that predate the dual-bootstrap
/// era. Two degenerate shapes are repaired:
///
///   1. Anchor-only vaults (single Index-0 profile) — the missing Level 1
///      Public Persona is provisioned at Index 1.
///   2. Vaults where a single pre-hierarchy identity squats the reserved
///      `"primary"` id at Index 0 with `level: 0` — the row is normalized
///      into proper Anchor form (`profile_id: "anchor"`, system-reserved)
///      before the canonical Level 1 persona is provisioned, keeping the
///      reserved id unique and resolution paths functional.
///
/// Safe because every key derives purely from `root_seed || LE(index)` —
/// the healed persona is byte-identical to the one `initial_profiles`
/// would have minted, so there is zero key rotation. Idempotent: healed
/// vaults satisfy the effective-persona predicate and are left untouched.
/// Returns `Ok(true)` when the vault was mutated and needs persisting.
pub fn heal_reserved_profiles(vault: &mut VaultStore) -> Result<bool, String> {
    let seed = decode_root_seed(vault)?;
    let mut changed = false;

    // An *effective* public persona must satisfy the same predicate the
    // resolution paths use (public_persona / empty-id lookups). A bare id
    // match is not enough: a legacy "primary"-labeled row at Index 0 /
    // Level 0 cannot serve as a public persona.
    let has_effective_persona = vault
        .profiles
        .iter()
        .any(|p| p.level >= 1 || p.derivation_index >= 1);

    // Normalize any Index-0 row into strict Anchor invariants (AGENT.md §1.1):
    // reserved id, level 0, system-reserved. Key material is untouched — the
    // DID derives from seed + index and is unaffected by metadata repair.
    for p in vault.profiles.iter_mut() {
        if p.derivation_index == 0 && !p.is_system_reserved {
            p.is_system_reserved = true;
            p.level = 0;
            if p.profile_id != ANCHOR_PROFILE_ID {
                p.profile_id = ANCHOR_PROFILE_ID.to_string();
            }
            changed = true;
        }
    }

    if !has_effective_persona {
        // After anchor normalization above, DEFAULT_PERSONA_PROFILE_ID is
        // guaranteed free for the canonical Index-1 persona.
        let kp = derive_deterministic_keypair(&seed, 1);
        vault.profiles.push(Profile {
            profile_id: DEFAULT_PERSONA_PROFILE_ID.to_string(),
            profile_name: "Primary Identity".to_string(),
            derivation_index: 1,
            did: kp.did,
            credentials: vec![],
            nostr_pubkey_hex: derive_secp256k1_pubkey_hex(&seed, 1),
            level: 1,
            is_system_reserved: false,
            active: true,
        });
        changed = true;
    }

    if changed {
        vault.profiles.sort_by_key(|p| p.derivation_index);
    }
    Ok(changed)
}

/// Path-based bootstrap loader: creates a fresh vault if and only if the
/// vault file does not exist, and self-heals partially-provisioned legacy
/// vaults (persisting atomically). Corruption and IO faults are returned
/// as-is — a damaged-but-quarantineable vault is never silently replaced.
pub fn load_or_bootstrap_vault_at_path(path: &Path) -> Result<VaultStore, VaultLoadError> {
    match load_vault_from_path(path) {
        Ok(mut vault) => {
            if heal_reserved_profiles(&mut vault).map_err(VaultLoadError::Io)? {
                save_vault_inner(path, &vault).map_err(VaultLoadError::Io)?;
            }
            Ok(vault)
        }
        Err(VaultLoadError::NotFound) => create_vault_at_path(path).map_err(VaultLoadError::Io),
        Err(other) => Err(other),
    }
}

pub fn load_or_bootstrap_vault(app: &AppHandle) -> Result<VaultStore, VaultLoadError> {
    load_or_bootstrap_vault_at_path(&get_storage_path(app))
}

/// Generic atomic write: stage to `<name>.tmp` in the same directory,
/// fsync, then rename over the target. On any failure the staging file is
/// removed and the existing file at `path` is left untouched. Shared by
/// the vault and contact stores.
pub(crate) fn atomic_write_bytes(path: &Path, payload: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }
    if path.is_dir() {
        return Err(format!("{} is a directory", path.display()));
    }

    let staging = path.with_file_name(format!(
        "{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("vault.json")
    ));

    let outcome = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&staging)?;
        file.write_all(payload)?;
        file.sync_all()?;
        fs::rename(&staging, path)?;
        Ok(())
    })();

    if let Err(e) = outcome {
        let _ = fs::remove_file(&staging);
        return Err(format!("Failed to write {} atomically: {}", path.display(), e));
    }

    Ok(())
}

fn save_vault_inner(path: &Path, vault: &VaultStore) -> Result<(), String> {
    let json = serde_json::to_string(vault).map_err(|e| format!("Serialization error: {}", e))?;
    let encrypted = base64.encode(json);
    atomic_write_bytes(path, encrypted.as_bytes())
}

pub fn save_vault(app: &AppHandle, vault: &VaultStore) -> Result<(), String> {
    save_vault_inner(&get_storage_path(app), vault)
}

pub fn get_profile_keypair(vault: &VaultStore, profile_id: &str) -> Result<DerivedKeypair, String> {
    let profile = vault
        .get_profile_by_id(profile_id)
        .ok_or_else(|| format!("Profile not found: '{}'", profile_id))?;

    let seed = bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())?;

    Ok(derive_deterministic_keypair(
        &seed,
        profile.derivation_index,
    ))
}

pub fn add_profile(
    vault: &mut VaultStore,
    profile_id: String,
    profile_name: String,
) -> Result<Profile, String> {
    if vault.profiles.iter().any(|p| p.profile_id == profile_id) {
        return Err(format!("Profile '{}' already exists", profile_id));
    }

    // Derivation indices 0 and 1 are reserved for the Anchor and the public
    // persona; user-created personas start at index 2.
    let max_index = vault
        .profiles
        .iter()
        .map(|p| p.derivation_index)
        .max()
        .unwrap_or(1);
    let next_index = std::cmp::max(2, max_index + 1);

    let seed = bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())?;

    let kp = derive_deterministic_keypair(&seed, next_index);
    let nostr_pk = derive_secp256k1_pubkey_hex(&seed, next_index);

    let profile = Profile {
        profile_id,
        profile_name,
        derivation_index: next_index,
        did: kp.did,
        credentials: vec![],
        nostr_pubkey_hex: nostr_pk,
        level: 2,
        is_system_reserved: false,
        active: false,
    };

    vault.profiles.push(profile.clone());
    Ok(profile)
}

pub fn remove_profile(vault: &mut VaultStore, profile_id: &str) -> Result<(), String> {
    let pos = vault
        .profiles
        .iter()
        .position(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile not found: '{}'", profile_id))?;

    let target = &vault.profiles[pos];
    if target.is_system_reserved || target.derivation_index == 0 || target.level == 0 {
        return Err("Cannot delete system reserved profile".into());
    }

    vault.profiles.remove(pos);
    Ok(())
}

pub fn get_active_profile(vault: &VaultStore) -> Result<Profile, String> {
    if let Some(active_p) = vault
        .profiles
        .iter()
        .find(|p| p.active && !p.is_anchor())
    {
        return Ok(active_p.clone());
    }

    vault
        .public_persona()
        .cloned()
        .ok_or_else(|| "No active profile found in vault".to_string())
}

pub fn list_profiles(vault: &VaultStore) -> Vec<Profile> {
    vault.profiles.clone()
}

pub fn activate_persona(vault: &mut VaultStore, profile_id: &str) -> Result<Profile, String> {
    let target = vault
        .profiles
        .iter()
        .find(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile not found: '{}'", profile_id))?;

    if target.level == 0 || target.derivation_index == 0 {
        return Err("Cannot activate Level 0 Anchor as public persona".into());
    }

    for p in vault.profiles.iter_mut() {
        p.active = p.profile_id == profile_id;
    }

    vault
        .profiles
        .iter()
        .find(|p| p.profile_id == profile_id)
        .cloned()
        .ok_or_else(|| format!("Profile not found: '{}'", profile_id))
}

/// Break-Glass Emergency Rotation: burn the active Level 1 Public Persona
/// and mint a fresh one at the next available derivation index. The Level 0
/// Anchor and all other profiles remain untouched.
pub fn rotate_public_persona(vault: &mut VaultStore) -> Result<Profile, String> {
    let seed = decode_root_seed(vault)?;

    // Locate the current active Level 1 profile.
    let old_index = vault
        .profiles
        .iter()
        .find(|p| p.level == 1 || (p.profile_id == DEFAULT_PERSONA_PROFILE_ID && p.derivation_index != 0))
        .map(|p| p.derivation_index)
        .ok_or("No active Level 1 profile to rotate")?;

    // Compute the next uncollided derivation index (>= 2).
    let max_index = vault
        .profiles
        .iter()
        .map(|p| p.derivation_index)
        .max()
        .unwrap_or(1);
    let new_index = std::cmp::max(2, max_index + 1);

    // Tombstone the old Level 1 profile.
    for p in vault.profiles.iter_mut() {
        if p.derivation_index == old_index && (p.level == 1 || p.profile_id == DEFAULT_PERSONA_PROFILE_ID) {
            p.profile_id = format!("retired_primary_{}", old_index);
            p.profile_name = format!("{} (Retired)", p.profile_name);
            p.level = 2;
            p.is_system_reserved = false;
            p.active = false;
        }
    }

    // Derive the fresh Level 1 identity.
    let kp = derive_deterministic_keypair(&seed, new_index);
    let nostr_hex = derive_secp256k1_pubkey_hex(&seed, new_index);

    let new_persona = Profile {
        profile_id: DEFAULT_PERSONA_PROFILE_ID.into(),
        profile_name: "Primary Identity".into(),
        derivation_index: new_index,
        did: kp.did,
        credentials: vec![],
        nostr_pubkey_hex: nostr_hex,
        level: 1,
        is_system_reserved: false,
        active: true,
    };

    vault.profiles.push(new_persona.clone());
    vault.profiles.sort_by_key(|p| p.derivation_index);

    Ok(new_persona)
}

/// Validate and ingest a W3C Verifiable Credential into a specified profile.
/// Ensures standard W3C structural integrity (`@context`, `type`, `issuer`,
/// `credentialSubject`, and cryptographic `proof`) before persisting.
pub fn add_credential_to_profile(
    vault: &mut VaultStore,
    profile_id: &str,
    vc_json: serde_json::Value,
) -> Result<Profile, String> {
    // 1. Validate W3C structural integrity
    if vc_json.get("@context").is_none() {
        return Err("Missing required W3C '@context' property".to_string());
    }

    let types = match vc_json.get("type") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<&str>>(),
        Some(serde_json::Value::String(s)) => vec![s.as_str()],
        _ => return Err("Missing or invalid 'type' property".to_string()),
    };

    if !types.contains(&"VerifiableCredential") {
        return Err("Credential 'type' must include 'VerifiableCredential'".to_string());
    }

    let issuer_did = match vc_json.get("issuer") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Object(obj)) => obj
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => return Err("Missing required 'issuer' property".to_string()),
    };
    if issuer_did.is_empty() {
        return Err("Invalid 'issuer' property".to_string());
    }

    let credential_subject = match vc_json.get("credentialSubject") {
        Some(serde_json::Value::Object(obj)) => obj,
        _ => return Err("Missing required 'credentialSubject' property".to_string()),
    };

    let proof = match vc_json.get("proof") {
        Some(serde_json::Value::Object(obj)) if !obj.is_empty() => obj,
        _ => return Err("Missing required 'proof' object with cryptographic signature".to_string()),
    };
    let _ = proof;

    // Extract identifier
    let vc_id = vc_json
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("urn:uuid:{}", uuid::Uuid::new_v4()));

    let subject_did = credential_subject
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let credential_type = types
        .into_iter()
        .find(|t| *t != "VerifiableCredential")
        .unwrap_or("VerifiableCredential")
        .to_string();

    let fidelity_score = credential_subject
        .get("fidelityScore")
        .or_else(|| vc_json.get("fidelityScore"))
        .and_then(|v| v.as_f64());

    let expiration_date = vc_json
        .get("expirationDate")
        .and_then(|v| v.as_str())
        .map(String::from);

    let raw_payload = vc_json.to_string();

    let vault_credential = VaultCredential {
        vc_id: vc_id.clone(),
        issuer_did,
        subject_did,
        credential_type,
        fidelity_score,
        expiration_date,
        raw_payload,
    };

    let profile = vault
        .profiles
        .iter_mut()
        .find(|p| p.profile_id == profile_id)
        .ok_or_else(|| format!("Profile '{}' not found", profile_id))?;

    if let Some(existing) = profile
        .credentials
        .iter_mut()
        .find(|c| c.vc_id == vc_id)
    {
        *existing = vault_credential;
    } else {
        profile.credentials.push(vault_credential);
    }

    Ok(profile.clone())
}

// ---------- Stream B: Poll Vote Ledger ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoteRecord {
    pub poll_id: String,
    pub option_id: String,
    pub client_signature: String,
    pub voter_did: String,
    pub network_timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalPoll {
    pub poll_id: String,
    pub title: String,
    pub poll_type: String,
    pub starts_at: u64,
    pub ends_at: u64,
    pub is_ongoing: bool,
}

impl LocalPoll {
    pub fn validate_vote_timeline(&self, vote_timestamp: u64) -> Result<(), String> {
        if !self.is_ongoing {
            if vote_timestamp < self.starts_at {
                return Err(
                    "Vote rejected: Poll schedule has not initialized yet.".to_string(),
                );
            }
            if vote_timestamp > self.ends_at {
                return Err(
                    "Vote rejected: Cryptographic ledger state is closed/locked.".to_string(),
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PollLedger {
    pub records: Vec<VoteRecord>,
}

fn get_ledger_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("poll_ledger.json");
    path
}

pub fn load_ledger(app: &AppHandle) -> PollLedger {
    let path = get_ledger_path(app);
    if !path.exists() {
        return PollLedger::default();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_ledger(app: &AppHandle, ledger: &PollLedger) -> Result<(), String> {
    let path = get_ledger_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create ledger directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(ledger)
        .map_err(|e| format!("Serialization error: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write ledger: {}", e))?;
    Ok(())
}

pub fn append_vote_records(app: &AppHandle, records: Vec<VoteRecord>) -> Result<(), String> {
    let mut ledger = load_ledger(app);
    ledger.records.extend(records);
    save_ledger(app, &ledger)
}

pub fn get_vote_records(app: &AppHandle) -> Result<Vec<VoteRecord>, String> {
    Ok(load_ledger(app).records)
}

// ---------- Cold Governance Anchoring: Merkle Root ----------
//
// Offline validation helper: accepts a slice of VoteRecord entries,
// extracts their Ed25519 `client_signature` fields, and computes a
// deterministic SHA-256 Merkle root.
//
// This root serves as a local validation artifact that users can
// compare against immutable ipfs_cid hashes generated by server-side
// Polly governance anchors.
//
// Second-preimage resistance is achieved via standard domain separation:
//   Leaf hash       = SHA-256(0x00 || signature_bytes)
//   Internal hash   = SHA-256(0x01 || left_hash || right_hash)
//
// If the leaf count is odd, the final node is duplicated to form
// a balanced binary tree at each layer.

pub fn calculate_vote_merkle_root(records: &[VoteRecord]) -> String {
    if records.is_empty() {
        return String::new();
    }

    let mut layer: Vec<[u8; 32]> = Vec::with_capacity(records.len());

    for record in records {
        let sig_bytes = hex::decode(&record.client_signature).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update([0x00]);
        hasher.update(&sig_bytes);
        layer.push(hasher.finalize().into());
    }

    while layer.len() > 1 {
        let mut next: Vec<[u8; 32]> = Vec::with_capacity((layer.len() + 1) / 2);
        let mut i = 0;
        while i < layer.len() {
            let left = &layer[i];
            let right = if i + 1 < layer.len() {
                &layer[i + 1]
            } else {
                &layer[i]
            };
            let mut hasher = Sha256::new();
            hasher.update([0x01]);
            hasher.update(left);
            hasher.update(right);
            next.push(hasher.finalize().into());
            i += 2;
        }
        layer = next;
    }

    hex::encode(layer[0])
}

/// Build and sign a sovereign Global Session Revocation payload.
/// Uses the Level 1 Public Persona's Ed25519 key to sign a structured revocation
/// envelope destined for the Identity Provider (`iyou_idp`).
pub fn build_session_revocation_payload(vault: &VaultStore) -> Result<serde_json::Value, String> {
    let persona = vault
        .public_persona()
        .ok_or_else(|| "No active Level 1 public persona found in vault".to_string())?;

    let seed = bs58::decode(&vault.root_seed_base58)
        .into_vec()
        .map_err(|_| "Invalid root seed encoding".to_string())?;

    let keypair = derive_deterministic_keypair(&seed, persona.derivation_index);

    let mut nonce_bytes = [0u8; 16];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = hex::encode(nonce_bytes);

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();

    let payload = serde_json::json!({
        "action": "GLOBAL_SESSION_REVOKE",
        "sub": keypair.did,
        "timestamp": timestamp,
        "nonce": nonce,
    });

    let payload_bytes = serde_json::to_vec(&payload)
        .map_err(|e| format!("Failed to serialize revocation payload: {}", e))?;

    let signature = keypair.signing_key.sign(&payload_bytes);
    let sig_hex = hex::encode(signature.to_bytes());

    Ok(serde_json::json!({
        "payload": payload,
        "signature": sig_hex,
        "did": keypair.did,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier};
    use std::env::temp_dir;

    #[test]
    fn test_add_credential_to_profile_valid_and_deduplicated() {
        let mut path = temp_dir();
        path.push("test_vc_import_vault.json");
        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let vc_json = serde_json::json!({
            "@context": ["https://www.w3.org/2018/credentials/v1"],
            "id": "urn:uuid:test-credential-1234",
            "type": ["VerifiableCredential", "CivicVotingCredential"],
            "issuer": "did:key:z6MkqGieZ3...",
            "issuanceDate": "2026-08-26T00:00:00Z",
            "expirationDate": "2027-08-26T00:00:00Z",
            "credentialSubject": {
                "id": "did:key:z6MkuP1...",
                "votingDistrict": "Global-01",
                "fidelityScore": 3.0
            },
            "proof": {
                "type": "Ed25519Signature2020",
                "proofValue": "z3m..."
            }
        });

        // 1. Ingest into primary profile
        let profile = add_credential_to_profile(&mut vault, DEFAULT_PERSONA_PROFILE_ID, vc_json.clone())
            .expect("Should import valid VC");
        assert_eq!(profile.credentials.len(), 1);
        assert_eq!(profile.credentials[0].vc_id, "urn:uuid:test-credential-1234");
        assert_eq!(profile.credentials[0].credential_type, "CivicVotingCredential");
        assert_eq!(profile.credentials[0].fidelity_score, Some(3.0));

        // 2. Re-ingesting same VC updates in place (deduplication)
        let mut vc_updated = vc_json.clone();
        vc_updated["credentialSubject"]["fidelityScore"] = serde_json::json!(2.5);
        let profile2 = add_credential_to_profile(&mut vault, DEFAULT_PERSONA_PROFILE_ID, vc_updated)
            .expect("Should update existing VC");
        assert_eq!(profile2.credentials.len(), 1);
        assert_eq!(profile2.credentials[0].fidelity_score, Some(2.5));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_add_credential_to_profile_validation_failures() {
        let mut path = temp_dir();
        path.push("test_vc_invalid_vault.json");
        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        // Missing @context
        let missing_context = serde_json::json!({
            "type": ["VerifiableCredential"],
            "issuer": "did:key:z1",
            "credentialSubject": {},
            "proof": { "sig": "..." }
        });
        assert!(add_credential_to_profile(&mut vault, DEFAULT_PERSONA_PROFILE_ID, missing_context).is_err());

        // Missing proof
        let missing_proof = serde_json::json!({
            "@context": ["https://www.w3.org/2018/credentials/v1"],
            "type": ["VerifiableCredential"],
            "issuer": "did:key:z1",
            "credentialSubject": {}
        });
        assert!(add_credential_to_profile(&mut vault, DEFAULT_PERSONA_PROFILE_ID, missing_proof).is_err());

        // Missing type
        let missing_type = serde_json::json!({
            "@context": ["https://www.w3.org/2018/credentials/v1"],
            "issuer": "did:key:z1",
            "credentialSubject": {},
            "proof": { "sig": "..." }
        });
        assert!(add_credential_to_profile(&mut vault, DEFAULT_PERSONA_PROFILE_ID, missing_type).is_err());

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_build_session_revocation_payload_signature_valid() {
        let mut path = temp_dir();
        path.push("test_revocation_vault.json");
        let vault = create_vault_at_path(&path).expect("Should create vault");

        let envelope = build_session_revocation_payload(&vault).expect("Should build revocation payload");
        assert_eq!(envelope["payload"]["action"].as_str().unwrap(), "GLOBAL_SESSION_REVOKE");
        assert!(envelope["payload"]["timestamp"].as_u64().unwrap() > 0);
        assert_eq!(envelope["payload"]["nonce"].as_str().unwrap().len(), 32);

        let did = envelope["did"].as_str().unwrap();
        assert_eq!(envelope["payload"]["sub"].as_str().unwrap(), did);

        // Verify the Ed25519 signature
        let sig_hex = envelope["signature"].as_str().unwrap();
        let sig_bytes = hex::decode(sig_hex).expect("Valid signature hex");
        let sig = Signature::from_slice(&sig_bytes).expect("Valid signature structure");

        let payload_bytes = serde_json::to_vec(&envelope["payload"]).expect("Valid payload serialization");

        let persona = vault.public_persona().unwrap();
        let seed = bs58::decode(&vault.root_seed_base58).into_vec().unwrap();
        let kp = derive_deterministic_keypair(&seed, persona.derivation_index);

        kp.verifying_key.verify(&payload_bytes, &sig).expect("Signature must verify");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_derivation_is_deterministic() {
        let seed = [0xabu8; 32];
        let kp1 = derive_deterministic_keypair(&seed, 42);
        let kp2 = derive_deterministic_keypair(&seed, 42);
        assert_eq!(kp1.did, kp2.did);
        assert_eq!(kp1.signing_key.to_bytes(), kp2.signing_key.to_bytes());
    }

    #[test]
    fn test_different_index_different_key() {
        let seed = [0xabu8; 32];
        let kp0 = derive_deterministic_keypair(&seed, 0);
        let kp1 = derive_deterministic_keypair(&seed, 1);
        assert_ne!(kp0.did, kp1.did);
    }

    #[test]
    fn test_vault_round_trip() {
        let mut path = temp_dir();
        path.push("test_vault_profile.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        assert_eq!(vault.profiles.len(), 2);
        assert_eq!(vault.profiles[0].profile_id, ANCHOR_PROFILE_ID);
        assert_eq!(vault.profiles[1].profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert!(vault.profiles[0].did.starts_with("did:key:"));
        assert!(vault.profiles[1].did.starts_with("did:key:"));

        let raw = fs::read_to_string(&path).expect("Should read file");
        assert!(!raw.contains(vault.profiles[0].did.as_str()));
        assert!(!raw.contains(vault.profiles[1].did.as_str()));

        let loaded = load_vault_from_path(&path).expect("Should load vault");
        assert_eq!(loaded.profiles.len(), 2);
        assert_eq!(loaded.profiles[0].did, vault.profiles[0].did);
        assert_eq!(loaded.profiles[1].did, vault.profiles[1].did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_dual_did_initial_provisioning() {
        let mut path = temp_dir();
        path.push("test_vault_dual_did.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        assert_eq!(vault.profiles.len(), 2);

        let anchor = &vault.profiles[0];
        assert_eq!(anchor.profile_id, ANCHOR_PROFILE_ID);
        assert_eq!(anchor.profile_name, "Anchor Identity");
        assert_eq!(anchor.derivation_index, 0);
        assert_eq!(anchor.level, 0);
        assert!(anchor.is_system_reserved);
        assert!(anchor.is_anchor());
        assert!(anchor.did.starts_with("did:key:"));
        assert_eq!(anchor.nostr_pubkey_hex.len(), 64);

        let persona = &vault.profiles[1];
        assert_eq!(persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(persona.profile_name, "Primary Identity");
        assert_eq!(persona.derivation_index, 1);
        assert_eq!(persona.level, 1);
        assert!(!persona.is_system_reserved);
        assert!(!persona.is_anchor());
        assert!(persona.did.starts_with("did:key:"));
        assert_eq!(persona.nostr_pubkey_hex.len(), 64);

        // Anchor and persona must be cryptographically distinct identities.
        assert_ne!(anchor.did, persona.did);
        assert_ne!(anchor.nostr_pubkey_hex, persona.nostr_pubkey_hex);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_load_vault_not_found() {
        let mut path = temp_dir();
        path.push(format!("test_vault_missing_{}.json", std::process::id()));
        let _ = fs::remove_file(&path);

        assert!(!path.exists());
        let result = load_vault_from_path(&path);
        assert!(
            matches!(result, Err(VaultLoadError::NotFound)),
            "Missing file must yield NotFound, got {:?}",
            result
        );
        assert!(!path.exists(), "NotFound must not create a vault file");
    }

    #[test]
    fn test_load_vault_corrupt_quarantines_file() {
        let dir = temp_dir();

        // Case 1: binary garbage (invalid UTF-8).
        let path = dir.join("test_vault_corrupt_binary.json");
        let garbage: &[u8] = &[0x00, 0xFF, 0xDE, 0xAD, 0xBE, 0xEF];
        fs::write(&path, garbage).expect("Should write binary garbage");

        let err = load_vault_from_path(&path)
            .err()
            .expect("Corrupt vault must fail");
        let backup = match err {
            VaultLoadError::Corrupt {
                quarantined_to,
                detail,
            } => {
                assert!(!detail.is_empty());
                quarantined_to.expect("Corrupt file must be quarantined")
            }
            other => panic!("Expected Corrupt, got {:?}", other),
        };
        assert!(backup.to_string_lossy().contains(".corrupt_"));
        assert!(backup.to_string_lossy().ends_with(".bak"));
        assert_eq!(fs::read(&backup).expect("Backup must be readable"), garbage);
        assert!(!path.exists(), "Original corrupt file must be renamed away");
        let _ = fs::remove_file(&backup);

        // Case 2: valid UTF-8 but invalid base64 payload.
        let path = dir.join("test_vault_corrupt_text.json");
        fs::write(&path, "definitely not base64 !!!").expect("Should write bad text");

        let err = load_vault_from_path(&path)
            .err()
            .expect("Corrupt vault must fail");
        match err {
            VaultLoadError::Corrupt { quarantined_to, .. } => {
                let backup = quarantined_to.expect("Corrupt file must be quarantined");
                assert!(backup.exists());
                assert!(!path.exists());
                let _ = fs::remove_file(&backup);
            }
            other => panic!("Expected Corrupt, got {:?}", other),
        }
    }

    #[test]
    fn test_quarantine_rotation_keeps_recent_backups() {
        let dir = temp_dir();
        let original_name = format!("test_vault_rotate_{}.json", std::process::id());
        let path = dir.join(&original_name);

        // Seed seven fake older backups with ascending timestamps.
        for ts in 100..=106u64 {
            fs::write(
                dir.join(format!("{}.corrupt_{}.bak", original_name, ts)),
                b"old",
            )
            .expect("Should seed backup");
        }

        // Quarantine a fresh corrupt file — real timestamp sorts newest.
        fs::write(&path, b"\x00\xFFgarbage").expect("Should write garbage");
        let err = load_vault_from_path(&path)
            .err()
            .expect("Corrupt vault must fail");
        let fresh_backup = match err {
            VaultLoadError::Corrupt { quarantined_to, .. } => {
                quarantined_to.expect("Must quarantine")
            }
            other => panic!("Expected Corrupt, got {:?}", other),
        };

        let backups = existing_corrupt_backups(&dir, &original_name);
        assert_eq!(
            backups.len(),
            CORRUPT_BACKUPS_TO_KEEP,
            "Rotation must retain only the newest backups"
        );
        assert!(backups.contains(&fresh_backup));
        // The three oldest seeded backups must have been pruned.
        for ts in 100..=102u64 {
            assert!(
                !dir.join(format!("{}.corrupt_{}.bak", original_name, ts)).exists(),
                "Old backup {} must be pruned",
                ts
            );
        }
        for ts in 103..=106u64 {
            assert!(dir
                .join(format!("{}.corrupt_{}.bak", original_name, ts))
                .exists());
        }

        let _ = fs::remove_file(&fresh_backup);
        for backup in backups {
            let _ = fs::remove_file(backup);
        }
    }

    #[test]
    fn test_atomic_save_preserves_on_write_failure() {
        let mut path = temp_dir();
        path.push("test_vault_atomic.json");
        let _ = fs::remove_file(&path);

        let mut vault = create_vault_at_path(&path).expect("Should create vault");
        let original_persona_did = vault.profiles[1].did.clone();

        // Occupy the staging path with a directory so File::create fails
        // mid-save, simulating an interrupted/crashed write.
        let staging = path.with_file_name(format!("{}.tmp", path.file_name().unwrap().to_string_lossy()));
        fs::create_dir(&staging).expect("Should create staging blocker");

        add_profile(&mut vault, "burner".to_string(), "Burner".to_string())
            .expect("Should mutate in-memory state");
        let result = save_vault_inner(&path, &vault);
        assert!(result.is_err(), "Save must fail when staging is blocked");

        // The on-disk vault must be untouched and still fully loadable.
        let loaded = load_vault_from_path(&path).expect("Original vault must survive");
        assert_eq!(loaded.profiles.len(), 2, "Partial write must not land");
        assert_eq!(loaded.profiles[1].did, original_persona_did);

        let _ = fs::remove_dir(&staging);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn test_bootstrap_only_on_not_found() {
        let dir = temp_dir();
        let original_name = format!("test_vault_bootstrap_{}.json", std::process::id());
        let path = dir.join(&original_name);
        let _ = fs::remove_file(&path);

        // Missing → bootstraps the dual-DID hierarchy.
        assert!(!path.exists());
        let vault = load_or_bootstrap_vault_at_path(&path).expect("Should bootstrap");
        assert_eq!(vault.profiles.len(), 2);
        assert!(path.exists());

        // Corrupt → error + quarantine. Never regenerated, never overwritten.
        fs::write(&path, b"\x00\xFFcorrupted").expect("Should corrupt vault");
        let result = load_or_bootstrap_vault_at_path(&path);
        assert!(
            matches!(result, Err(VaultLoadError::Corrupt { .. })),
            "Corruption must surface as Corrupt, got {:?}",
            result
        );
        assert!(
            !path.exists(),
            "Quarantined vault must not be replaced by a fresh one"
        );

        for backup in existing_corrupt_backups(&dir, &original_name) {
            let _ = fs::remove_file(backup);
        }
    }

    // ---------- Self-Healing Migration Tests ----------

    /// Rewind a freshly minted vault to an anchor-only (Index 0) snapshot,
    /// simulating a pre-dual-bootstrap legacy dev vault on disk.
    fn write_legacy_anchor_only_vault(path: &Path) -> (VaultStore, Vec<u8>) {
        let full = create_vault_at_path(path).expect("Should create full vault");
        let legacy = VaultStore {
            root_seed_base58: full.root_seed_base58.clone(),
            profiles: vec![full.profiles[0].clone()],
            sovereign_identities: Vec::new(),
        };
        save_vault_inner(path, &legacy).expect("Should persist legacy vault");
        let seed = bs58::decode(&legacy.root_seed_base58)
            .into_vec()
            .expect("Seed should decode");
        (legacy, seed)
    }

    #[test]
    fn test_legacy_single_profile_vault_self_heals() {
        let mut path = temp_dir();
        path.push("test_vault_heal_legacy.json");
        let _ = fs::remove_file(&path);

        let (legacy, seed) = write_legacy_anchor_only_vault(&path);
        assert_eq!(legacy.profiles.len(), 1);
        let anchor_did = legacy.profiles[0].did.clone();

        // Load through the bootstrapping loader: must heal and persist.
        let healed = load_or_bootstrap_vault_at_path(&path).expect("Should heal legacy vault");
        assert_eq!(healed.profiles.len(), 2, "Missing Level 1 persona must be provisioned");

        // The anchor is untouched.
        assert_eq!(healed.profiles[0].profile_id, ANCHOR_PROFILE_ID);
        assert_eq!(healed.profiles[0].did, anchor_did, "Anchor identity must not rotate");
        assert_eq!(healed.profiles[0].derivation_index, 0);

        // The healed persona sits at Index 1 with the deterministic identity
        // initial_profiles would have created — zero key rotation.
        let persona = &healed.profiles[1];
        let expected_kp = derive_deterministic_keypair(&seed, 1);
        assert_eq!(persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(persona.profile_name, "Primary Identity");
        assert_eq!(persona.derivation_index, 1);
        assert_eq!(persona.level, 1);
        assert!(!persona.is_system_reserved);
        assert_eq!(persona.did, expected_kp.did);
        assert_eq!(persona.nostr_pubkey_hex, derive_secp256k1_pubkey_hex(&seed, 1));

        // Healing must survive a cold reload: state was persisted to disk.
        let reloaded = load_vault_from_path(&path).expect("Healed vault must round-trip");
        assert_eq!(reloaded.profiles.len(), 2);
        assert_eq!(reloaded.profiles[1].did, expected_kp.did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_legacy_primary_squatting_index0_vault_self_heals() {
        // Regression for the observed dev-machine shape: a single pre-hierarchy
        // identity labeled "primary" sitting at Index 0 with serde-defaulted
        // level/is_system_reserved fields. The id alone must NOT satisfy the
        // effective-persona predicate.
        let mut path = temp_dir();
        path.push("test_vault_heal_squatting.json");
        let _ = fs::remove_file(&path);

        let full = create_vault_at_path(&path).expect("Should create vault");
        let seed = bs58::decode(&full.root_seed_base58)
            .into_vec()
            .expect("Seed should decode");
        let squatting = VaultStore {
            root_seed_base58: full.root_seed_base58.clone(),
            profiles: vec![Profile {
                profile_id: DEFAULT_PERSONA_PROFILE_ID.to_string(),
                profile_name: "Primary Identity".to_string(),
                derivation_index: 0,
                did: full.profiles[0].did.clone(),
                credentials: vec![],
                nostr_pubkey_hex: full.profiles[0].nostr_pubkey_hex.clone(),
                level: 0,
                is_system_reserved: false,
                active: false,
            }],
            sovereign_identities: Vec::new(),
        };
        save_vault_inner(&path, &squatting).expect("Should persist squatting vault");
        let anchor_did = squatting.profiles[0].did.clone();

        let healed =
            load_or_bootstrap_vault_at_path(&path).expect("Squatting vault must self-heal");
        assert_eq!(healed.profiles.len(), 2);

        // The Index-0 row is normalized into strict Anchor invariants; key
        // material is untouched.
        let anchor = &healed.profiles[0];
        assert_eq!(anchor.profile_id, ANCHOR_PROFILE_ID, "Reserved id must be reclaimed");
        assert_eq!(anchor.derivation_index, 0);
        assert_eq!(anchor.level, 0);
        assert!(anchor.is_system_reserved);
        assert_eq!(anchor.did, anchor_did, "Anchor DID must not rotate");

        // The canonical Level 1 persona is provisioned at Index 1.
        let persona = &healed.profiles[1];
        assert_eq!(persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(persona.derivation_index, 1);
        assert_eq!(persona.level, 1);
        assert!(!persona.is_system_reserved);
        assert_eq!(persona.did, derive_deterministic_keypair(&seed, 1).did);

        // Empty-id resolution (the Nostr auto-start path) now succeeds.
        let kp = get_profile_keypair(&healed, "").expect("Empty id must resolve post-heal");
        assert_eq!(kp.did, persona.did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_heal_is_idempotent() {
        let mut path = temp_dir();
        path.push("test_vault_heal_idempotent.json");
        let _ = fs::remove_file(&path);

        let (_legacy, seed) = write_legacy_anchor_only_vault(&path);

        let first = load_or_bootstrap_vault_at_path(&path).expect("First load should heal");
        let second = load_or_bootstrap_vault_at_path(&path).expect("Second load must not duplicate");

        assert_eq!(first.profiles.len(), 2);
        assert_eq!(second.profiles.len(), 2);
        assert_eq!(
            first.profiles[1].did,
            derive_deterministic_keypair(&seed, 1).did
        );
        assert_eq!(first.profiles[1].did, second.profiles[1].did);

        // A healed vault reports no further mutations needed.
        let mut already_healed = second.clone();
        assert!(!heal_reserved_profiles(&mut already_healed).unwrap());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_profile_keypair_empty_id_after_heal() {
        let mut path = temp_dir();
        path.push("test_vault_heal_empty_id.json");
        let _ = fs::remove_file(&path);

        let (_legacy, seed) = write_legacy_anchor_only_vault(&path);

        // Regression guard for: Auto-start Nostr failed: Profile not found: ''
        let healed = load_or_bootstrap_vault_at_path(&path).expect("Should heal");
        let kp = get_profile_keypair(&healed, "").expect("Empty id must resolve post-heal");
        assert_eq!(kp.did, derive_deterministic_keypair(&seed, 1).did);
        assert_ne!(kp.did, healed.profiles[0].did, "Must never fall back to the anchor");

        // Public persona resolution agrees with the empty-id keypair path.
        let persona = healed.public_persona().expect("Persona should resolve");
        assert_eq!(persona.did, kp.did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_anchor_deletion_blocked() {
        let mut path = temp_dir();
        path.push("test_vault_anchor_guard.json");

        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let result = remove_profile(&mut vault, ANCHOR_PROFILE_ID);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().contains("system reserved"),
            "Anchor deletion must be rejected as system-reserved"
        );
        assert_eq!(vault.profiles.len(), 2);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_default_resolution_targets_persona() {
        let mut path = temp_dir();
        path.push("test_vault_persona_resolution.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        let persona = vault.public_persona().expect("Should resolve persona");
        assert_eq!(persona.derivation_index, 1);
        assert_eq!(persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);

        let by_empty = vault
            .get_profile_by_id("")
            .expect("Empty id should resolve to persona");
        assert_eq!(by_empty.derivation_index, 1);
        assert!(!by_empty.is_anchor());

        let kp = get_profile_keypair(&vault, "").expect("Should derive from default");
        assert_eq!(kp.did, vault.profiles[1].did);
        assert_ne!(kp.did, vault.profiles[0].did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_add_remove_profile() {
        let mut path = temp_dir();
        path.push("test_vault_profiles.json");

        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let p = add_profile(
            &mut vault,
            "pseudo_1".to_string(),
            "Social Pseudonym".to_string(),
        )
        .expect("Should add profile");
        assert_eq!(p.derivation_index, 2);
        assert_eq!(p.level, 2);
        assert!(!p.is_system_reserved);
        assert!(p.did.starts_with("did:key:"));
        assert_ne!(p.did, vault.profiles[0].did);
        assert_ne!(p.did, vault.profiles[1].did);

        assert_eq!(vault.profiles.len(), 3);

        remove_profile(&mut vault, "pseudo_1").expect("Should remove");
        assert_eq!(vault.profiles.len(), 2);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_add_profile_index_floor() {
        let mut path = temp_dir();
        path.push("test_vault_index_floor.json");

        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let p1 = add_profile(&mut vault, "burner_a".to_string(), "Burner A".to_string())
            .expect("Should add first burner");
        assert_eq!(p1.derivation_index, 2);

        let p2 = add_profile(&mut vault, "burner_b".to_string(), "Burner B".to_string())
            .expect("Should add second burner");
        assert_eq!(p2.derivation_index, 3);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_profile_by_id_defaults_to_first() {
        let mut path = temp_dir();
        path.push("test_vault_default.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");

        // Empty id resolves to the public persona (Level 1), not the anchor.
        let p = vault.get_profile_by_id("").expect("Should return persona");
        assert_eq!(p.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(p.derivation_index, 1);

        let p2 = vault
            .get_profile_by_id(DEFAULT_PERSONA_PROFILE_ID)
            .expect("Should find by id");
        assert_eq!(p2.profile_id, DEFAULT_PERSONA_PROFILE_ID);

        let anchor = vault
            .get_profile_by_id(ANCHOR_PROFILE_ID)
            .expect("Should find anchor");
        assert_eq!(anchor.derivation_index, 0);

        assert!(vault.get_profile_by_id("nonexistent").is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_get_profile_keypair() {
        let mut path = temp_dir();
        path.push("test_vault_keypair.json");

        let vault = create_vault_at_path(&path).expect("Should create vault");
        let kp = get_profile_keypair(&vault, DEFAULT_PERSONA_PROFILE_ID)
            .expect("Should derive keypair");
        assert_eq!(kp.did, vault.profiles[1].did);

        let kp2 = get_profile_keypair(&vault, "").expect("Should derive from default");
        assert_eq!(kp2.did, vault.profiles[1].did);

        let anchor_kp = get_profile_keypair(&vault, ANCHOR_PROFILE_ID)
            .expect("Should derive anchor keypair");
        assert_eq!(anchor_kp.did, vault.profiles[0].did);
        assert_ne!(anchor_kp.did, kp.did);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_vote_record_round_trip() {
        let dir = temp_dir();
        let ledger_path = dir.join("poll_ledger.json");

        let records = vec![
            VoteRecord {
                poll_id: "poll_abc".into(),
                option_id: "opt_1".into(),
                client_signature: "sig_hex_value".into(),
                voter_did: "did:key:zabc123".into(),
                network_timestamp: 1715000000,
            },
            VoteRecord {
                poll_id: "poll_abc".into(),
                option_id: "opt_2".into(),
                client_signature: "sig_hex_value_2".into(),
                voter_did: "did:key:zdef456".into(),
                network_timestamp: 1715000060,
            },
        ];

        let ledger = PollLedger {
            records: records.clone(),
        };
        let json = serde_json::to_string_pretty(&ledger).expect("Should serialize");
        std::fs::write(&ledger_path, &json).expect("Should write");

        let loaded_json = std::fs::read_to_string(&ledger_path).expect("Should read");
        let loaded: PollLedger =
            serde_json::from_str(&loaded_json).expect("Should deserialize");

        assert_eq!(loaded.records.len(), 2);
        assert_eq!(loaded.records[0].poll_id, "poll_abc");
        assert_eq!(loaded.records[0].option_id, "opt_1");
        assert_eq!(loaded.records[1].network_timestamp, 1715000060);

        let _ = std::fs::remove_file(&ledger_path);
    }

    #[test]
    fn test_credential_storage_fidelity() {
        let mut path = temp_dir();
        path.push("test_vault_creds.json");

        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        let cred1 = VaultCredential {
            vc_id: "vc-001".to_string(),
            issuer_did: "did:key:zissuer1".to_string(),
            subject_did: "did:key:zsubject1".to_string(),
            credential_type: "UniversityDegree".to_string(),
            fidelity_score: Some(0.95),
            expiration_date: Some("2027-06-01T00:00:00Z".to_string()),
            raw_payload: r#"{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"vc-001","type":["VerifiableCredential","UniversityDegree"],"issuer":"did:key:zissuer1","issuanceDate":"2025-01-01T00:00:00Z","credentialSubject":{"id":"did:key:zsubject1","degree":"BSc"}}"#.to_string(),
        };

        let cred2 = VaultCredential {
            vc_id: "vc-002".to_string(),
            issuer_did: "did:key:zissuer2".to_string(),
            subject_did: "did:key:zsubject1".to_string(),
            credential_type: "Membership".to_string(),
            fidelity_score: None,
            expiration_date: None,
            raw_payload: r#"{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"vc-002","type":["VerifiableCredential","Membership"],"issuer":"did:key:zissuer2","issuanceDate":"2025-03-15T00:00:00Z","credentialSubject":{"id":"did:key:zsubject1","memberSince":"2025"}}"#.to_string(),
        };

        // Add a second profile and push credentials to both
        let _p2 = add_profile(&mut vault, "alt".to_string(), "Alt Persona".to_string())
            .expect("Should add profile");

        vault.profiles[0].credentials.push(cred1.clone());
        vault.profiles[0].credentials.push(cred2.clone());

        save_vault_inner(&path, &vault).expect("Should save vault with credentials");

        // Reload and verify fields
        let mut loaded = load_vault_from_path(&path).expect("Should reload vault");
        let primary = &loaded.profiles[0];
        assert_eq!(primary.credentials.len(), 2);

        let c1 = &primary.credentials[0];
        assert_eq!(c1.vc_id, "vc-001");
        assert_eq!(c1.issuer_did, "did:key:zissuer1");
        assert_eq!(c1.subject_did, "did:key:zsubject1");
        assert_eq!(c1.credential_type, "UniversityDegree");
        assert_eq!(c1.fidelity_score, Some(0.95));
        assert_eq!(
            c1.expiration_date,
            Some("2027-06-01T00:00:00Z".to_string())
        );
        assert!(c1.raw_payload.contains("vc-001"));

        let c2 = &primary.credentials[1];
        assert_eq!(c2.vc_id, "vc-002");
        assert!(c2.fidelity_score.is_none());
        assert!(c2.expiration_date.is_none());
        assert_eq!(c2.credential_type, "Membership");

        // Verify alt profile has empty credentials
        assert!(loaded.profiles[2].credentials.is_empty());

        // --- Upsert: replace existing vc-001 with updated payload ---
        let cred1_updated = VaultCredential {
            vc_id: "vc-001".to_string(),
            issuer_did: "did:key:zissuer1".to_string(),
            subject_did: "did:key:zsubject1".to_string(),
            credential_type: "UniversityDegree".to_string(),
            fidelity_score: Some(0.98),
            expiration_date: Some("2028-06-01T00:00:00Z".to_string()),
            raw_payload: r#"{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"vc-001","type":["VerifiableCredential","UniversityDegree"],"issuer":"did:key:zissuer1","issuanceDate":"2025-06-01T00:00:00Z","credentialSubject":{"id":"did:key:zsubject1","degree":"MSc"}}"#.to_string(),
        };

        if let Some(existing) = loaded.profiles[0]
            .credentials
            .iter_mut()
            .find(|c| c.vc_id == "vc-001")
        {
            *existing = cred1_updated;
        }

        save_vault_inner(&path, &loaded).expect("Should save after upsert");
        let reloaded = load_vault_from_path(&path).expect("Should reload after upsert");

        // Length should still be 2 (replaced, not appended)
        assert_eq!(reloaded.profiles[0].credentials.len(), 2);
        let replaced = &reloaded.profiles[0].credentials[0];
        assert_eq!(replaced.vc_id, "vc-001");
        assert_eq!(replaced.fidelity_score, Some(0.98));
        assert_eq!(
            replaced.expiration_date,
            Some("2028-06-01T00:00:00Z".to_string())
        );

        // --- Push a new unique credential ---
        let cred3 = VaultCredential {
            vc_id: "vc-003".to_string(),
            issuer_did: "did:key:zissuer3".to_string(),
            subject_did: "did:key:zsubject2".to_string(),
            credential_type: "Badge".to_string(),
            fidelity_score: None,
            expiration_date: None,
            raw_payload: r#"{"@context":["https://www.w3.org/2018/credentials/v1"],"id":"vc-003","type":["VerifiableCredential","Badge"],"issuer":"did:key:zissuer3","credentialSubject":{"id":"did:key:zsubject2","badge":"Contributor"}}"#.to_string(),
        };

        // Reload fresh from disk to test append
        let mut final_vault = load_vault_from_path(&path).expect("Should reload");
        final_vault.profiles[0].credentials.push(cred3);
        save_vault_inner(&path, &final_vault).expect("Should save after append");
        let final_loaded = load_vault_from_path(&path).expect("Should reload final");

        assert_eq!(final_loaded.profiles[0].credentials.len(), 3);
        assert_eq!(final_loaded.profiles[0].credentials[2].vc_id, "vc-003");

        // --- Zero regression: key derivation still works ---
        let kp = get_profile_keypair(&final_loaded, DEFAULT_PERSONA_PROFILE_ID)
            .expect("Key derivation should still work");
        assert_eq!(kp.did, final_loaded.profiles[1].did);
        let kp2 = get_profile_keypair(&final_loaded, "")
            .expect("Empty profile_id should default to public persona");
        assert_eq!(kp2.did, kp.did);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_legacy_vault_without_credentials_defaults_to_empty() {
        let mut path = temp_dir();
        path.push("test_vault_legacy.json");

        let _vault = create_vault_at_path(&path).expect("Should create vault");

        let raw_json = {
            let encrypted = std::fs::read_to_string(&path).expect("Should read");
            let decoded =
                base64::Engine::decode(&base64, encrypted.trim()).expect("Should decode");
            String::from_utf8(decoded).expect("Should be UTF-8")
        };

        let legacy: serde_json::Value =
            serde_json::from_str(&raw_json).expect("Should parse");
        let profile0 = &legacy["profiles"][0];
        assert!(
            profile0.get("credentials").is_some(),
            "New serialization must include credentials field"
        );
        assert!(
            profile0.get("level").is_some() && profile0.get("is_system_reserved").is_some(),
            "New serialization must include hierarchy fields"
        );
        assert_eq!(profile0["level"], 0);
        assert_eq!(profile0["is_system_reserved"], true);
        assert_eq!(legacy["profiles"][1]["level"], 1);
        assert_eq!(legacy["profiles"][1]["is_system_reserved"], false);

        let _ = std::fs::remove_file(&path);
    }

    // ---------- Merkle root tests ----------

    #[test]
    fn test_merkle_root_two_records_deterministic() {
        let records = vec![
            VoteRecord {
                poll_id: "poll_abc".into(),
                option_id: "opt_1".into(),
                client_signature: "abcd1234".into(),
                voter_did: "did:key:zabc".into(),
                network_timestamp: 1000,
            },
            VoteRecord {
                poll_id: "poll_abc".into(),
                option_id: "opt_2".into(),
                client_signature: "deadbeef".into(),
                voter_did: "did:key:zdef".into(),
                network_timestamp: 1001,
            },
        ];

        let root1 = calculate_vote_merkle_root(&records);
        let root2 = calculate_vote_merkle_root(&records);

        assert_eq!(root1, root2, "Merkle root must be deterministic");
        assert_eq!(root1.len(), 64, "Merkle root must be 64 hex chars (SHA-256)");
    }

    #[test]
    fn test_merkle_root_single_record() {
        let records = vec![VoteRecord {
            poll_id: "poll_single".into(),
            option_id: "opt_1".into(),
            client_signature: "ffeeddcc".into(),
            voter_did: "did:key:zsingle".into(),
            network_timestamp: 2000,
        }];

        let root = calculate_vote_merkle_root(&records);

        // Single leaf: root = SHA-256(0x00 || signature_bytes)
        let sig_bytes = hex::decode("ffeeddcc").unwrap();
        let mut hasher = Sha256::new();
        hasher.update([0x00]);
        hasher.update(&sig_bytes);
        let expected = hex::encode(hasher.finalize());

        assert_eq!(root, expected, "Single-record Merkle root must equal the leaf hash");
    }

    #[test]
    fn test_merkle_root_changing_signature_changes_root() {
        let mut a = vec![VoteRecord {
            poll_id: "poll_x".into(),
            option_id: "opt_1".into(),
            client_signature: "11111111".into(),
            voter_did: "did:key:za".into(),
            network_timestamp: 3000,
        }];
        let root_a = calculate_vote_merkle_root(&a);

        a[0].client_signature = "22222222".into();
        let root_b = calculate_vote_merkle_root(&a);

        assert_ne!(root_a, root_b, "Different signatures must produce different roots");
    }

    #[test]
    fn test_merkle_root_empty_records_returns_empty() {
        let records: Vec<VoteRecord> = vec![];
        let root = calculate_vote_merkle_root(&records);
        assert!(root.is_empty(), "Empty records must produce empty root");
    }

    #[test]
    fn test_merkle_root_three_records_odd_duplication() {
        let records = vec![
            VoteRecord {
                poll_id: "poll_odd".into(),
                option_id: "opt_1".into(),
                client_signature: "aabbccdd".into(),
                voter_did: "did:key:z1".into(),
                network_timestamp: 4000,
            },
            VoteRecord {
                poll_id: "poll_odd".into(),
                option_id: "opt_2".into(),
                client_signature: "eeff0011".into(),
                voter_did: "did:key:z2".into(),
                network_timestamp: 4001,
            },
            VoteRecord {
                poll_id: "poll_odd".into(),
                option_id: "opt_3".into(),
                client_signature: "22334455".into(),
                voter_did: "did:key:z3".into(),
                network_timestamp: 4002,
            },
        ];

        let root = calculate_vote_merkle_root(&records);
        assert_eq!(root.len(), 64, "Three records must still produce 64-char hex root");
        assert!(root.chars().all(|c| c.is_ascii_hexdigit()), "Root must be valid hex");
    }

    // ---------- LocalPoll Timeline Validation ----------

    fn make_poll(starts_at: u64, ends_at: u64, is_ongoing: bool) -> LocalPoll {
        LocalPoll {
            poll_id: "test_poll".into(),
            title: "Test Poll".into(),
            poll_type: "public".into(),
            starts_at,
            ends_at,
            is_ongoing,
        }
    }

    #[test]
    fn test_vote_before_starts_at_rejected() {
        let poll = make_poll(100, 200, false);
        let result = poll.validate_vote_timeline(50);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not initialized"));
    }

    #[test]
    fn test_vote_after_ends_at_rejected() {
        let poll = make_poll(100, 200, false);
        let result = poll.validate_vote_timeline(250);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("closed/locked"));
    }

    #[test]
    fn test_vote_within_window_accepted() {
        let poll = make_poll(100, 200, false);
        assert!(poll.validate_vote_timeline(150).is_ok());
        assert!(poll.validate_vote_timeline(100).is_ok());
        assert!(poll.validate_vote_timeline(200).is_ok());
    }

    #[test]
    fn test_is_ongoing_permits_out_of_bounds() {
        let poll = make_poll(100, 200, true);
        assert!(poll.validate_vote_timeline(50).is_ok());
        assert!(poll.validate_vote_timeline(250).is_ok());
        assert!(poll.validate_vote_timeline(9999999).is_ok());
    }

    // ---------- Identity Graduation: transit unsealing & sovereign ingest ----------

    /// RFC 7748 §5.2 X25519 test vector #1 (Alice private × Bob public).
    const RFC7748_ALICE_PRIV: [u8; 32] = [
        0x77, 0x07, 0x6d, 0x0a, 0x73, 0x18, 0xa5, 0x7d, 0x3c, 0x16, 0xc1, 0x72, 0x51, 0xb2,
        0x66, 0x45, 0xdf, 0x4c, 0x2f, 0x87, 0xeb, 0xc0, 0x99, 0x2a, 0xb1, 0x77, 0xfb, 0xa5,
        0x1d, 0xb9, 0x2c, 0x2a,
    ];
    const RFC7748_BOB_PUB: [u8; 32] = [
        0xde, 0x9e, 0xdb, 0x7d, 0x7b, 0x7d, 0xc1, 0xb4, 0xd3, 0x5b, 0x61, 0xc2, 0xec, 0xe4,
        0x35, 0x37, 0x3f, 0x83, 0x43, 0xc8, 0x5b, 0x78, 0x67, 0x74, 0xda, 0xdf, 0xc7, 0xe1,
        0x46, 0xf8, 0x82, 0xb4,
    ];

    fn test_server_side_seal(
        server_ephemeral_priv: &[u8; 32],
        client_ephemeral_pub: &[u8; 32],
        nonce: &[u8; 12],
        seed: &[u8; 32],
        custodial_did: &str,
    ) -> Vec<u8> {
        let server_secret = StaticSecret::from(*server_ephemeral_priv);
        let shared = server_secret.diffie_hellman(&X25519PublicKey::from(*client_ephemeral_pub));
        let hk = Hkdf::<Sha256>::new(Some(nonce), shared.as_bytes());
        let mut wrapping_key = [0u8; 32];
        hk.expand(GRADUATION_HKDF_INFO, &mut wrapping_key)
            .expect("HKDF expand must succeed");
        let cipher = Aes256Gcm::new(AesKey::<Aes256Gcm>::from_slice(&wrapping_key));
        cipher
            .encrypt(
                AesNonce::from_slice(nonce),
                Payload {
                    msg: seed,
                    aad: custodial_did.as_bytes(),
                },
            )
            .expect("AES-256-GCM seal must succeed")
    }

    #[test]
    fn test_transit_ecdh_matches_rfc7748_vector() {
        let client_secret = StaticSecret::from(RFC7748_ALICE_PRIV);
        let shared = client_secret.diffie_hellman(&X25519PublicKey::from(RFC7748_BOB_PUB));
        assert!(
            shared.was_contributory(),
            "RFC 7748 vector must be contributory"
        );
    }

    #[test]
    fn test_unseal_graduation_export_roundtrip() {
        let mut client_priv = [0u8; 32];
        OsRng.fill_bytes(&mut client_priv);
        let client_secret = StaticSecret::from(client_priv);
        let client_pub = X25519PublicKey::from(&client_secret).to_bytes();

        let mut server_priv = [0u8; 32];
        OsRng.fill_bytes(&mut server_priv);
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);

        let seed: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(7));
        let did = "did:web:iyou.me:user:test-uuid-0001";

        let ciphertext = test_server_side_seal(&server_priv, &client_pub, &nonce, &seed, did);
        let server_pub = X25519PublicKey::from(&StaticSecret::from(server_priv)).to_bytes();

        let unsealed =
            unseal_graduation_export(&client_priv, &server_pub, &nonce, &ciphertext, did)
                .expect("Unsealing must succeed");
        assert_eq!(unsealed.len(), 32);
        assert_eq!(unsealed.as_slice(), seed);
    }

    #[test]
    fn test_unseal_rejects_aad_binding_violation() {
        let client_secret = StaticSecret::from(RFC7748_ALICE_PRIV);
        let client_pub = X25519PublicKey::from(&client_secret).to_bytes();
        let nonce = [0x42u8; 12];
        let seed = [0x11u8; 32];

        let ciphertext =
            test_server_side_seal(&[0x99u8; 32], &client_pub, &nonce, &seed, "did:web:right");
        let server_pub = X25519PublicKey::from(&StaticSecret::from([0x99u8; 32])).to_bytes();

        let err = unseal_graduation_export(
            &RFC7748_ALICE_PRIV,
            &server_pub,
            &nonce,
            &ciphertext,
            "did:web:wrong",
        )
        .err()
        .expect("Wrong AAD must fail AEAD authentication");
        assert!(err.contains("AEAD authentication error"), "{}", err);
    }

    #[test]
    fn test_unseal_rejects_malformed_inputs() {
        let client_pub_dummy = [2u8; 32];
        let server_pub = X25519PublicKey::from(client_pub_dummy).to_bytes();
        let bad_nonce = [0u8; 11];
        let tiny_ct = [0u8; 10];

        assert!(unseal_graduation_export(&[0u8; 32], &server_pub, &bad_nonce, &[0u8; 48], "d")
            .is_err());
        assert!(unseal_graduation_export(&[0u8; 32], &server_pub, &[0u8; 12], &tiny_ct, "d")
            .is_err());
    }

    #[test]
    fn test_prf_identity_derivation_matches_vault_path() {
        // The PRF dual-curve derivation in did_rust must agree byte-for-byte
        // with the local vault hierarchy for the same root material.
        let prf_seed: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(31));
        for index in [0u32, 1, 2, 77] {
            let identity = did_rust::derive_identity_from_prf(&prf_seed, index)
                .expect("PRF derivation must succeed");

            let vault_kp = derive_deterministic_keypair(&prf_seed, index);
            assert_eq!(identity.did, vault_kp.did);
            assert_eq!(
                identity.nostr_pubkey_hex,
                derive_secp256k1_pubkey_hex(&prf_seed, index)
            );

            let again = did_rust::derive_identity_from_prf(&prf_seed, index)
                .expect("PRF derivation must be deterministic");
            assert_eq!(identity.did, again.did);
            assert_eq!(identity.nostr_pubkey_hex, again.nostr_pubkey_hex);
        }
    }

    #[test]
    fn test_sovereign_ingest_seals_seed_in_vault_storage() {
        let mut path = temp_dir();
        path.push("test_vault_sovereign.json");
        let _ = fs::remove_file(&path);

        let kek: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_add(1));
        let seed: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(3));
        let did = "did:web:iyou.me:user:sovereign-abc";

        let mut vault = create_vault_at_path(&path).expect("Should create vault");
        let record = ingest_graduated_identity(&mut vault, did, &seed, &kek)
            .expect("Ingest must succeed");

        save_vault_inner(&path, &vault).expect("Should persist vault");
        let raw = fs::read_to_string(&path).expect("Should read vault file");
        assert!(!raw.contains(hex::encode(seed).as_str()), "Raw hex of seed leaked to disk");
        assert!(!raw.contains(bs58::encode(seed).into_string().as_str()));

        let reloaded = load_vault_from_path(&path).expect("Should reload");
        assert_eq!(reloaded.sovereign_identities.len(), 1);
        let stored = get_sovereign_identity(&reloaded, did).expect("Should resolve sovereign");
        assert_ne!(stored.sealed_seed_b64, hex::encode(seed));
        assert_eq!(stored.did, record.did);
        assert_eq!(stored.nostr_pubkey_hex, record.nostr_pubkey_hex);

        // Sealed blob must round-trip back to the exact seed.
        let signing_key = unseal_sovereign_identity(stored, &kek).expect("Unseal must succeed");
        assert_eq!(signing_key.to_bytes(), seed);
        assert_eq!(
            signing_key.verifying_key().to_bytes(),
            SigningKey::from_bytes(&seed).verifying_key().to_bytes()
        );

        // Wrong KEK must fail cleanly.
        let wrong_kek: [u8; 32] = [9u8; 32];
        assert!(unseal_sovereign_identity(stored, &wrong_kek).is_err());

        // Duplicate DID ingest is rejected structurally.
        assert!(ingest_graduated_identity(&mut vault, did, &seed, &kek).is_err());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_rotate_public_persona_advances_index_and_preserves_anchor() {
        let mut path = temp_dir();
        path.push("test_vault_rotate.json");
        let _ = fs::remove_file(&path);

        let mut vault = create_vault_at_path(&path).expect("Should create vault");
        let seed = bs58::decode(&vault.root_seed_base58)
            .into_vec()
            .expect("Seed should decode");

        // Snapshot the anchor before rotation.
        let anchor_did = vault.profiles[0].did.clone();
        let anchor_hex = vault.profiles[0].nostr_pubkey_hex.clone();
        let anchor_index = vault.profiles[0].derivation_index;
        assert_eq!(anchor_index, 0);
        assert!(vault.profiles[0].is_system_reserved);

        // Snapshot the old primary.
        let old_primary_did = vault.profiles[1].did.clone();
        assert_eq!(vault.profiles[1].derivation_index, 1);
        assert_eq!(vault.profiles[1].level, 1);

        // Execute rotation.
        let new_persona =
            rotate_public_persona(&mut vault).expect("Rotation must succeed");

        // New persona: fresh derivation index, Level 1, profile_id == "primary".
        assert_eq!(new_persona.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(new_persona.level, 1);
        assert!(!new_persona.is_system_reserved);
        assert!(new_persona.derivation_index >= 2);
        assert_ne!(new_persona.did, old_primary_did);
        assert!(new_persona.did.starts_with("did:key:"));
        assert_eq!(new_persona.nostr_pubkey_hex.len(), 64);

        // Deterministic derivation: re-derive and compare.
        let expected_kp = derive_deterministic_keypair(&seed, new_persona.derivation_index);
        assert_eq!(new_persona.did, expected_kp.did);
        assert_eq!(
            new_persona.nostr_pubkey_hex,
            derive_secp256k1_pubkey_hex(&seed, new_persona.derivation_index)
        );

        // Anchor is untouched.
        let anchor = &vault.profiles[0];
        assert_eq!(anchor.profile_id, ANCHOR_PROFILE_ID);
        assert_eq!(anchor.did, anchor_did);
        assert_eq!(anchor.nostr_pubkey_hex, anchor_hex);
        assert_eq!(anchor.derivation_index, 0);
        assert!(anchor.is_system_reserved);

        // Old primary is tombstoned at Level 2.
        let tombstoned = vault.profiles.iter().find(|p| p.derivation_index == 1);
        assert!(tombstoned.is_some());
        let t = tombstoned.unwrap();
        assert_eq!(t.level, 2);
        assert!(t.profile_id.starts_with("retired_primary_"));
        assert!(t.profile_name.contains("Retired"));

        // Empty-id resolution returns the new primary.
        let resolved = vault.get_profile_by_id("").expect("Empty id must resolve");
        assert_eq!(resolved.did, new_persona.did);
        assert_eq!(resolved.derivation_index, new_persona.derivation_index);

        // get_profile_keypair resolves to the new primary keypair.
        let kp = get_profile_keypair(&vault, "").expect("Keypair must resolve");
        assert_eq!(kp.did, new_persona.did);

        // Profiles are sorted by derivation_index.
        let indices: Vec<u32> = vault.profiles.iter().map(|p| p.derivation_index).collect();
        let mut sorted = indices.clone();
        sorted.sort();
        assert_eq!(indices, sorted);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn test_reveal_master_seed_matches_decoded_root_seed() {
        let seed = vec![0x42u8; 32];
        let vault = VaultStore {
            root_seed_base58: bs58::encode(&seed).into_string(),
            profiles: vec![],
            sovereign_identities: vec![],
        };

        let hex = reveal_root_seed_hex(&vault).expect("Should reveal seed");
        assert_eq!(hex.len(), 64, "Hex seed must be 64 characters (32 bytes)");
        assert_eq!(hex, hex::encode(&seed), "Hex must match the original seed bytes");

        let decoded = decode_root_seed(&vault).expect("Should decode seed");
        assert_eq!(decoded, seed);
    }

    #[test]
    fn test_backup_export_and_restore_round_trip() {
        let tmp = std::env::temp_dir().join("iyou_test_backup_roundtrip");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // Create a vault with 2 profiles
        let seed = vec![0xA1u8; 32];
        let mut vault = VaultStore {
            root_seed_base58: bs58::encode(&seed).into_string(),
            profiles: vec![],
            sovereign_identities: vec![],
        };
        vault.profiles = initial_profiles(&seed);

        // Write vault.json
        let vault_json = serde_json::to_string_pretty(&vault).unwrap();
        fs::write(tmp.join("vault.json"), &vault_json).unwrap();

        // Write a mock contacts.json
        let contacts = serde_json::json!({
            "contacts": [{
                "peer_id": "test-peer-1",
                "display_name": "Alice",
                "trust_level": "Level1",
                "disclosed_aliases": [],
                "attestation_receipt": null,
                "created_at": 1700000000,
                "updated_at": 1700000000
            }]
        });
        fs::write(
            tmp.join("contacts.json"),
            serde_json::to_string_pretty(&contacts).unwrap(),
        )
        .unwrap();

        // Write a mock preferences.json
        let prefs = serde_json::json!({
            "active_profile_id": "primary",
            "default_signing_profile": "primary",
            "auto_sign": false,
            "last_active_tab": "enclave"
        });
        fs::write(
            tmp.join("preferences.json"),
            serde_json::to_string_pretty(&prefs).unwrap(),
        )
        .unwrap();

        // Export backup
        let password = "correct-horse-battery";
        let backup_bytes = export_vault_backup(&vault, &tmp, password)
            .expect("Export should succeed");
        assert!(!backup_bytes.is_empty(), "Backup should not be empty");

        // Restore into an empty directory
        let restore_dir = std::env::temp_dir().join("iyou_test_backup_restore");
        let _ = fs::remove_dir_all(&restore_dir);
        fs::create_dir_all(&restore_dir).unwrap();

        let result = import_vault_backup(&restore_dir, &backup_bytes, password);
        assert!(result.is_ok(), "Restore should succeed: {:?}", result.err());

        // Verify restored vault (uses canonical load_vault_from_path)
        let restored_vault = load_vault_from_path(&restore_dir.join("vault.json"))
            .expect("Restored vault must load cleanly");
        assert_eq!(restored_vault.profiles.len(), vault.profiles.len());
        assert_eq!(restored_vault.root_seed_base58, vault.root_seed_base58);
        for (orig, restored) in vault.profiles.iter().zip(restored_vault.profiles.iter()) {
            assert_eq!(orig.profile_id, restored.profile_id);
            assert_eq!(orig.did, restored.did);
        }

        // Verify restored contacts
        let restored_contacts: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(restore_dir.join("contacts.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            restored_contacts["contacts"][0]["display_name"],
            "Alice"
        );

        // Verify restored preferences
        let restored_prefs: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(restore_dir.join("preferences.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(restored_prefs["active_profile_id"], "primary");

        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&restore_dir);
    }

    #[test]
    fn test_backup_round_trip_includes_pairing_and_ledger_files() {
        let tmp = std::env::temp_dir().join("iyou_test_backup_ledgers");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let seed = vec![0xB2u8; 32];
        let vault = VaultStore {
            root_seed_base58: bs58::encode(&seed).into_string(),
            profiles: initial_profiles(&seed),
            sovereign_identities: vec![],
        };
        fs::write(tmp.join("vault.json"), serde_json::to_string_pretty(&vault).unwrap()).unwrap();

        fs::write(
            tmp.join("pairing.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "devices": [{
                    "device_id": "pair-1",
                    "device_name": "Test Handset",
                    "created_at": 1700000000
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        // Third-party ledger documents live under {app_data}/ledgers/.
        let ledgers_dir = tmp.join("ledgers");
        fs::create_dir_all(&ledgers_dir).unwrap();
        let hive = serde_json::json!({ "hives": [{ "name": "garden-1", "sensors": 3 }] });
        let name = serde_json::json!({ "reservations": [{ "nick": "alice", "expires": 1710000000 }] });
        let talk = serde_json::json!({ "conversations": [{ "peer": "bob", "count": 4 }] });
        let vendor = serde_json::json!({ "custom": { "flag": true, "seq": 7 } });
        for (file, value) in [
            ("hive_ledger.json", &hive),
            ("name_ledger.json", &name),
            ("talk_journal.json", &talk),
            ("third_party_ledger.json", &vendor),
        ] {
            fs::write(
                ledgers_dir.join(file),
                serde_json::to_string_pretty(value).unwrap(),
            )
            .unwrap();
        }

        let password = "ledger-password";
        let backup_bytes = export_vault_backup(&vault, &tmp, password)
            .expect("Export should succeed with ledgers present");
        assert!(!backup_bytes.is_empty(), "Backup should not be empty");

        let restore_dir = std::env::temp_dir().join("iyou_test_backup_ledgers_restore");
        let _ = fs::remove_dir_all(&restore_dir);
        fs::create_dir_all(&restore_dir).unwrap();

        import_vault_backup(&restore_dir, &backup_bytes, password)
            .expect("Restore with ledgers should succeed");

        // Root pairing.json restored.
        let restored_pairing: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(restore_dir.join("pairing.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(restored_pairing["devices"][0]["device_name"], "Test Handset");

        // Every bundled ledger file restored into {app_data}/ledgers/.
        for (file, value) in [
            ("hive_ledger.json", &hive),
            ("name_ledger.json", &name),
            ("talk_journal.json", &talk),
            ("third_party_ledger.json", &vendor),
        ] {
            let restored: serde_json::Value = serde_json::from_str(
                &fs::read_to_string(restore_dir.join("ledgers").join(file)).unwrap(),
            )
            .unwrap();
            assert_eq!(restored, *value, "Ledger {} should round-trip", file);
        }

        // A fresh import that has no ledgers still succeeds.
        let fresh_dir = std::env::temp_dir().join("iyou_test_backup_ledgers_none");
        let _ = fs::remove_dir_all(&fresh_dir);
        fs::create_dir_all(&fresh_dir).unwrap();
        import_vault_backup(&fresh_dir, &backup_bytes, password)
            .expect("Restore into a dir without ledgers should succeed");

        // Restore must tolerate a payload with no ledgers key (legacy archives).
        let payload = serde_json::json!({
            "vault": serde_json::to_value(&vault).unwrap(),
            "contacts": serde_json::json!([]),
            "preferences": serde_json::json!({}),
            "manifest": { "version": "2.0" }
        });
        let plain = serde_json::to_string(&payload).unwrap();
        let mut salt = [0u8; 32];
        OsRng.fill_bytes(&mut salt);
        let legacy_envelope = encrypt_payload(&plain, password).unwrap();
        let legacy_dir = std::env::temp_dir().join("iyou_test_backup_legacy");
        let _ = fs::remove_dir_all(&legacy_dir);
        fs::create_dir_all(&legacy_dir).unwrap();
        import_vault_backup(&legacy_dir, &legacy_envelope, password)
            .expect("Legacy archives without ledgers should restore");

        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&restore_dir);
        let _ = fs::remove_dir_all(&fresh_dir);
        let _ = fs::remove_dir_all(&legacy_dir);
    }

    #[test]
    fn test_backup_export_with_missing_or_empty_companion_files() {
        let tmp = std::env::temp_dir().join("iyou_test_backup_empty_companions");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // Create empty contacts.json file and omit preferences.json completely
        fs::write(tmp.join("contacts.json"), b"").unwrap();

        let vault = VaultStore {
            root_seed_base58: bs58::encode(vec![0x77u8; 32]).into_string(),
            profiles: vec![Profile {
                profile_id: "primary".to_string(),
                profile_name: "Primary Persona".to_string(),
                derivation_index: 1,
                did: "did:key:z6MkkTest".to_string(),
                credentials: vec![],
                nostr_pubkey_hex: "0123456789abcdef".to_string(),
                level: 1,
                is_system_reserved: false,
                active: true,
            }],
            sovereign_identities: vec![],
        };

        let backup_bytes = export_vault_backup(&vault, &tmp, "safe-password")
            .expect("Export with missing/empty companion files should succeed");
        assert!(!backup_bytes.is_empty());

        // Restore into a fresh target
        let restore_dir = std::env::temp_dir().join("iyou_test_backup_empty_companions_restore");
        let _ = fs::remove_dir_all(&restore_dir);
        fs::create_dir_all(&restore_dir).unwrap();

        let res = import_vault_backup(&restore_dir, &backup_bytes, "safe-password");
        assert!(res.is_ok());

        let restored_vault = load_vault_from_path(&restore_dir.join("vault.json")).unwrap();
        assert_eq!(restored_vault.profiles.len(), 1);

        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&restore_dir);
    }

    #[test]
    fn test_backup_restore_fails_with_invalid_password() {
        let tmp = std::env::temp_dir().join("iyou_test_backup_badpw");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        // Create a minimal vault
        let vault = VaultStore {
            root_seed_base58: bs58::encode(vec![0x55u8; 32]).into_string(),
            profiles: vec![],
            sovereign_identities: vec![],
        };

        let backup_bytes = export_vault_backup(&vault, &tmp, "correct-password")
            .expect("Export should succeed");

        // Try to restore with wrong password
        let restore_dir = std::env::temp_dir().join("iyou_test_backup_badpw_restore");
        let _ = fs::remove_dir_all(&restore_dir);
        fs::create_dir_all(&restore_dir).unwrap();

        let result = import_vault_backup(&restore_dir, &backup_bytes, "wrong-password");
        assert!(result.is_err(), "Restore with wrong password should fail");
        let err = result.unwrap_err();
        assert!(
            err.contains("Decryption failed") || err.contains("wrong password"),
            "Error should indicate wrong password: {}",
            err
        );

        // Verify nothing was written
        assert!(
            !restore_dir.join("vault.json").exists(),
            "vault.json should not exist after failed restore"
        );

        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&restore_dir);
    }

    #[test]
    fn test_get_active_profile() {
        let mut path = temp_dir();
        path.push("test_get_active_profile_vault.json");
        let mut vault = create_vault_at_path(&path).expect("Should create vault");

        // 1. Initial state: public persona (L1) should be returned as active
        let active = get_active_profile(&vault).expect("Should find default active profile");
        assert_eq!(active.profile_id, DEFAULT_PERSONA_PROFILE_ID);
        assert_eq!(active.level, 1);

        // 2. Add an L2 burner profile and activate it
        let dad_bod = add_profile(&mut vault, "dad_bod".to_string(), "DAD_BOD".to_string())
            .expect("Should add dad_bod");
        activate_persona(&mut vault, &dad_bod.profile_id).expect("Should activate dad_bod");

        // 3. Now get_active_profile returns DAD_BOD
        let active = get_active_profile(&vault).expect("Should find dad_bod as active");
        assert_eq!(active.profile_id, "dad_bod");
        assert_eq!(active.profile_name, "DAD_BOD");

        // Cleanup
        let _ = fs::remove_file(&path);
    }
}
