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

//! Offline device-pairing handshake for mobile vault companions.
//!
//! Flow: the desktop displays an offline QR deep link carrying an ephemeral
//! X25519 public key, a 12-byte nonce and a 6-character verification code
//! (5-minute TTL). The mobile companion opens the link, derives a shared
//! secret via ECDH, and the desktop seals the raw root seed under
//! AES-256-GCM with the code as a liveness proof. The raw seed never crosses
//! the frontend — only the sealed ciphertext envelope is returned.

use aes_gcm::aead::{Aead, AeadCore as _};
use aes_gcm::{Aes256Gcm, KeyInit as _};
use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter as _, Manager};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::vault;

/// Domain-separation label bound into every HKDF key expansion for pairing.
pub const PAIRING_HKDF_INFO: &[u8] = b"iyou-home/pair/v1";

/// Lifetime of an un-completed pairing frame in seconds.
pub const PAIR_FRAME_TTL_SECS: u64 = 300;

// ---------- Schema ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairedDeviceRecord {
    pub device_id: String,
    pub device_did: String,
    pub device_name: String,
    pub paired_at: u64,
    pub last_seen_at: u64,
    pub revoked_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PairingStore {
    pub devices: Vec<PairedDeviceRecord>,
}

/// A single in-progress handshake. Held in memory only; never persisted.
/// `ephemeral_secret` is zeroized on drop.
pub struct ActivePairFrame {
    pub frame_id: String,
    pub ephemeral_secret: Zeroizing<[u8; 32]>,
    #[allow(dead_code)] // surfaced to the mobile companion via the deep link
    pub ephemeral_pub_hex: String,
    pub nonce: [u8; 12],
    pub verification_code: String,
    pub expires_at: u64,
}

pub struct PairFrameState {
    pub frames: Mutex<HashMap<String, ActivePairFrame>>,
}

impl Default for PairFrameState {
    fn default() -> Self {
        Self {
            frames: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairFrameResponse {
    pub frame_id: String,
    pub verification_code: String,
    pub qr_png_b64: String,
    pub expires_at: u64,
}

/// Wire envelope handed to the mobile companion. Only ciphertext crosses the
/// frontend; decryption happens exclusively on the remote device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SealedSeedEnvelope {
    pub frame_id: String,
    pub device_did: String,
    pub iv_b64: String,
    pub ciphertext_b64: String,
}

// ---------- Helpers ----------

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn parse_x25519_pub(hex_str: &str) -> Result<PublicKey, String> {
    let bytes = hex::decode(hex_str.trim())
        .map_err(|_| "Invalid x25519 public key encoding".to_string())?;
    if bytes.len() != 32 {
        return Err("x25519 public key must be exactly 32 bytes".to_string());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(PublicKey::from(arr))
}

/// 6-character code from an unambiguous alphabet (no 0/O/1/I).
fn generate_verification_code() -> String {
    const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let mut rng = OsRng;
    let mut code = String::with_capacity(6);
    for _ in 0..6 {
        let idx = rand::Rng::gen_range(&mut rng, 0..ALPHABET.len());
        code.push(ALPHABET[idx] as char);
    }
    code
}

// ---------- QR / PNG rendering ----------

/// Render an offline deep-link URI as a base64-encoded PNG data URL.
pub fn render_qr_png_b64(uri: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(uri.as_bytes())
        .map_err(|e| format!("QR encode failed: {}", e))?;
    let modules = code.to_colors();
    let n = code.width();

    const QUIET_ZONE: usize = 4;
    const MODULE_PX: u32 = 8;
    let dim = u32::try_from(n + 2 * QUIET_ZONE)
        .unwrap_or(0)
        .saturating_mul(MODULE_PX);
    let dimu = dim as usize;

    let mut raw = vec![255u8; dimu * dimu];
    for my in 0..n {
        for mx in 0..n {
            if modules[my * n + mx] == qrcode::types::Color::Dark {
                let ox = (mx + QUIET_ZONE) * MODULE_PX as usize;
                let oy = (my + QUIET_ZONE) * MODULE_PX as usize;
                for y in 0..MODULE_PX as usize {
                    for x in 0..MODULE_PX as usize {
                        raw[(oy + y) * dimu + ox + x] = 0;
                    }
                }
            }
        }
    }

    let png = encode_png_grayscale(&raw, dim, dim)?;
    Ok(format!("data:image/png;base64,{}", base64.encode(&png)))
}

/// Minimal standalone PNG encoder for 8-bit grayscale buffers (no codec deps).
fn encode_png_grayscale(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use std::io::Write;

    let w = width as usize;
    let h = height as usize;
    if pixels.len() != w * h {
        return Err("Pixel buffer length does not match dimensions".to_string());
    }

    let mut scanlines = Vec::with_capacity(pixels.len() + h);
    for y in 0..h {
        scanlines.push(0u8);
        scanlines.extend_from_slice(&pixels[y * w..(y + 1) * w]);
    }

    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&scanlines)
        .map_err(|e| format!("PNG deflate failed: {}", e))?;
    let compressed = enc.finish().map_err(|e| format!("PNG deflate failed: {}", e))?;

    let mut out = Vec::with_capacity(compressed.len() + 64);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    // bit depth 8, color type 0 (grayscale), compression 0, filter 0, interlace 0
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
    write_png_chunk(&mut out, b"IHDR", &ihdr);
    write_png_chunk(&mut out, b"IDAT", &compressed);
    write_png_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

fn write_png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32fast::hash(&crc_input).to_be_bytes());
}

// ---------- Persistence ----------

pub fn get_pairing_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("pairing.json");
    path
}

/// Missing file is a normal first-run state (empty store). A corrupt file is
/// quarantined to `pairing.json.corrupt_<ts>.bak` and surfaced as an error —
/// never silently regenerated, matching contacts.json semantics.
pub fn load_pairing_store(app: &AppHandle) -> Result<PairingStore, String> {
    load_pairing_store_from_path(&get_pairing_path(app))
}

pub fn load_pairing_store_from_path(path: &Path) -> Result<PairingStore, String> {
    if !path.exists() {
        return Ok(PairingStore::default());
    }
    let raw = fs::read(path).map_err(|e| format!("Failed to read pairing store: {}", e))?;
    let parse_err = |detail: String| -> String {
        match vault::quarantine_corrupt_vault(path) {
            Ok(backup) => format!(
                "Pairing store corrupt (quarantined to {}): {}",
                backup.display(),
                detail
            ),
            Err(q) => format!("Pairing store corrupt (quarantine failed: {}): {}", q, detail),
        }
    };
    serde_json::from_slice::<PairingStore>(&raw)
        .map_err(|e| parse_err(format!("Failed to parse pairing store: {}", e)))
}

pub fn save_pairing_store(app: &AppHandle, store: &PairingStore) -> Result<(), String> {
    let json = serde_json::to_string(store)
        .map_err(|e| format!("Pairing store serialization error: {}", e))?;
    vault::atomic_write_bytes(&get_pairing_path(app), json.as_bytes())
}

// ---------- Pairing lifecycle ----------

/// Begin a new pairing frame: ephemeral X25519 keypair, 12-byte nonce,
/// 6-character code, 5-minute expiry, and an offline PNG QR deep link.
pub fn begin_pairing(state: &PairFrameState) -> Result<PairFrameResponse, String> {
    let now = unix_now();
    {
        let mut guard = state
            .frames
            .lock()
            .map_err(|_| "Pairing state poisoned".to_string())?;
        guard.retain(|_, f| f.expires_at > now);
    }

    let frame_id = uuid::Uuid::new_v4().to_string();

    let mut secret_bytes = [0u8; 32];
    OsRng.fill_bytes(&mut secret_bytes);
    let secret = StaticSecret::from(secret_bytes);
    let pub_hex = hex::encode(PublicKey::from(&secret).as_bytes());

    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);

    let verification_code = generate_verification_code();
    let expires_at = now + PAIR_FRAME_TTL_SECS;

    let deep_link = format!(
        "iyouhome://pair?frame_id={}&x25519={}&nonce={}&ver=1",
        frame_id,
        pub_hex,
        hex::encode(&nonce)
    );
    let qr_png_b64 = render_qr_png_b64(&deep_link)?;

    {
        let mut guard = state
            .frames
            .lock()
            .map_err(|_| "Pairing state poisoned".to_string())?;
        guard.insert(
            frame_id.clone(),
            ActivePairFrame {
                frame_id: frame_id.clone(),
                ephemeral_secret: Zeroizing::new(secret_bytes),
                ephemeral_pub_hex: pub_hex,
                nonce,
                verification_code: verification_code.clone(),
                expires_at,
            },
        );
    }

    Ok(PairFrameResponse {
        frame_id,
        verification_code,
        qr_png_b64,
        expires_at,
    })
}

/// Sealing core, independent of app/vault wiring so it is unit-testable.
/// `device_did` is bound as AAD and cross-checked by the receiver.
pub fn seal_seed_frame(
    frame: &ActivePairFrame,
    mobile_x25519_pub_hex: &str,
    device_did: &str,
    seed: &[u8],
) -> Result<Vec<u8>, String> {
    let did = device_did.trim();
    if did.is_empty() {
        return Err("device_did must not be empty".to_string());
    }
    let mobile_pub = parse_x25519_pub(mobile_x25519_pub_hex)?;

    let secret = StaticSecret::from(*frame.ephemeral_secret);
    let shared = secret.diffie_hellman(&mobile_pub);

    let hk = Hkdf::<Sha256>::new(Some(&frame.nonce[..]), shared.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(PAIRING_HKDF_INFO, &mut key)
        .map_err(|e| format!("HKDF expand failed: {}", e))?;
    let key = Zeroizing::new(key);

    let cipher = Aes256Gcm::new_from_slice(key.as_slice())
        .map_err(|_| "AES-256-GCM key init failed".to_string())?;
    let gcm_nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let aad = format!("{}\0{}", did, frame.frame_id);
    let ciphertext = cipher
        .encrypt(
            &gcm_nonce,
            aes_gcm::aead::Payload {
                msg: seed,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| "Seal failed — abandoning seed transit".to_string())?;

    let envelope = SealedSeedEnvelope {
        frame_id: frame.frame_id.clone(),
        device_did: did.to_string(),
        iv_b64: base64.encode(gcm_nonce.as_slice()),
        ciphertext_b64: base64.encode(&ciphertext),
    };
    serde_json::to_vec(&envelope).map_err(|e| format!("Envelope serialization failed: {}", e))
}

/// Consume a live frame, verify freshness + verification code, load the vault
/// root seed and seal it for the mobile device's X25519 key. Seed memory is
/// zeroized on drop; only the ciphertext envelope is returned.
pub fn seal_seed_for_device(
    app: &AppHandle,
    state: &PairFrameState,
    frame_id: &str,
    mobile_x25519_pub_hex: &str,
    device_did: &str,
    verification_code: &str,
) -> Result<Vec<u8>, String> {
    let now = unix_now();
    let frame = {
        let mut guard = state
            .frames
            .lock()
            .map_err(|_| "Pairing state poisoned".to_string())?;
        let frame = guard
            .remove(frame_id)
            .ok_or_else(|| "Pairing frame not found — expired or already used".to_string())?;
        if now >= frame.expires_at {
            return Err("Pairing frame expired — refresh the QR code".to_string());
        }
        if frame.verification_code != verification_code {
            return Err("Verification code mismatch".to_string());
        }
        frame
    };

    let store = load_pairing_store(app)?;
    if store
        .devices
        .iter()
        .any(|d| d.device_did == device_did.trim() && d.revoked_at.is_some())
    {
        return Err("Device is revoked and cannot receive a sealed seed frame".to_string());
    }

    let vault_store = vault::load_vault(app).map_err(|e| e.to_string())?;
    let seed = Zeroizing::new(vault::decode_root_seed(&vault_store)?);
    seal_seed_frame(&frame, mobile_x25519_pub_hex, device_did, &seed)
}

/// Bind a mobile device DID to this vault and persist it. Re-pairing an
/// existing (possibly revoked) DID resurrects the record with a fresh stamp.
pub fn confirm_pairing(
    app: &AppHandle,
    state: &PairFrameState,
    frame_id: &str,
    device_did: &str,
    device_name: &str,
) -> Result<PairedDeviceRecord, String> {
    if let Ok(mut guard) = state.frames.lock() {
        guard.remove(frame_id);
    }

    let did = device_did.trim().to_string();
    if did.is_empty() {
        return Err("device_did must not be empty".to_string());
    }
    let name = device_name.trim().to_string();
    if name.is_empty() {
        return Err("device_name must not be empty".to_string());
    }

    let now = unix_now();
    let mut store = load_pairing_store(app)?;

    let record = if let Some(existing) = store.devices.iter_mut().find(|d| d.device_did == did) {
        existing.device_name = name;
        existing.revoked_at = None;
        existing.last_seen_at = now;
        existing.clone()
    } else {
        let record = PairedDeviceRecord {
            device_id: uuid::Uuid::new_v4().to_string(),
            device_did: did,
            device_name: name,
            paired_at: now,
            last_seen_at: now,
            revoked_at: None,
        };
        store.devices.push(record.clone());
        record
    };

    save_pairing_store(app, &store)?;
    let _ = app.emit("pair://status", &record);
    Ok(record)
}

pub fn list_devices(app: &AppHandle) -> Result<Vec<PairedDeviceRecord>, String> {
    let mut devices = load_pairing_store(app)?.devices;
    devices.sort_by(|a, b| b.paired_at.cmp(&a.paired_at));
    Ok(devices)
}

pub fn revoke_device(app: &AppHandle, device_id: &str) -> Result<bool, String> {
    let now = unix_now();
    let mut store = load_pairing_store(app)?;
    let mut found = false;
    for d in store.devices.iter_mut() {
        if d.device_id == device_id {
            if d.revoked_at.is_none() {
                d.revoked_at = Some(now);
            }
            found = true;
        }
    }
    if !found {
        return Err("No such paired device".to_string());
    }
    save_pairing_store(app, &store)?;
    Ok(true)
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Payload;
    use aes_gcm::Nonce;

    fn pub_from_hex(s: &str) -> PublicKey {
        let bytes = hex::decode(s).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        PublicKey::from(arr)
    }

    #[cfg(test)]
    impl ActivePairFrame {
        fn clone_for_test(&self) -> ActivePairFrame {
            ActivePairFrame {
                frame_id: self.frame_id.clone(),
                ephemeral_secret: Zeroizing::new(*self.ephemeral_secret),
                ephemeral_pub_hex: self.ephemeral_pub_hex.clone(),
                nonce: self.nonce,
                verification_code: self.verification_code.clone(),
                expires_at: self.expires_at,
            }
        }
    }

    #[test]
    fn test_begin_pairing_fields() {
        let state = PairFrameState::default();
        let resp = begin_pairing(&state).expect("begin_pairing should succeed");

        assert_eq!(resp.verification_code.len(), 6);
        assert!(resp.verification_code.chars().all(|c| c.is_ascii_alphanumeric()));
        assert!(resp.expires_at > unix_now());
        assert!(resp.expires_at <= unix_now() + PAIR_FRAME_TTL_SECS);

        let png = base64
            .decode(resp.qr_png_b64.strip_prefix("data:image/png;base64,").unwrap())
            .expect("qr_png_b64 must decode");
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]));

        // Frame must be live in the state map with matching public key.
        let guard = state.frames.lock().unwrap();
        let frame = guard.get(&resp.frame_id).expect("frame must be stored");
        assert_eq!(frame.verification_code, resp.verification_code);
        assert_eq!(frame.expires_at, resp.expires_at);
        assert_eq!(frame.ephemeral_pub_hex.len(), 64);
    }

    #[test]
    fn test_deep_link_format() {
        let state = PairFrameState::default();
        let resp = begin_pairing(&state).unwrap();
        let guard = state.frames.lock().unwrap();
        let frame = guard.get(&resp.frame_id).unwrap();
        let uri = format!(
            "iyouhome://pair?frame_id={}&x25519={}&nonce={}&ver=1",
            frame.frame_id,
            frame.ephemeral_pub_hex,
            hex::encode(frame.nonce)
        );
        // The stored public key must match a X25519 public derived from the secret.
        let secret = StaticSecret::from(*frame.ephemeral_secret);
        let derived = hex::encode(PublicKey::from(&secret).as_bytes());
        assert_eq!(uri.contains(&derived), true);
    }

    #[test]
    fn test_seal_roundtrip() {
        let state = PairFrameState::default();
        let resp = begin_pairing(&state).unwrap();
        let guard = state.frames.lock().unwrap();
        let frame = guard.get(&resp.frame_id).unwrap().clone_for_test();

        let mut mobile_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut mobile_bytes);
        let mobile_secret = StaticSecret::from(mobile_bytes);
        let mobile_pub_hex = hex::encode(PublicKey::from(&mobile_secret).as_bytes());

        let envelope_bytes =
            seal_seed_frame(&frame, &mobile_pub_hex, "did:key:testmobile", b"root-seed-32b!!").unwrap();
        let envelope: SealedSeedEnvelope = serde_json::from_slice(&envelope_bytes).unwrap();
        assert_eq!(envelope.device_did, "did:key:testmobile");

        // Decrypt on the mobile side.
        let shared = mobile_secret.diffie_hellman(&pub_from_hex(&frame.ephemeral_pub_hex));
        let hk = Hkdf::<Sha256>::new(Some(&frame.nonce[..]), shared.as_bytes());
        let mut key = [0u8; 32];
        hk.expand(PAIRING_HKDF_INFO, &mut key).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let iv = base64.decode(&envelope.iv_b64).unwrap();
        let ct = base64.decode(&envelope.ciphertext_b64).unwrap();
        let aad = format!("{}\0{}", "did:key:testmobile", frame.frame_id);
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: &ct,
                    aad: aad.as_bytes(),
                },
            )
            .expect("decryption must succeed");
        assert_eq!(plaintext, b"root-seed-32b!!");
    }

    #[test]
    fn test_seal_binds_aad() {
        let state = PairFrameState::default();
        let resp = begin_pairing(&state).unwrap();
        let guard = state.frames.lock().unwrap();
        let frame = guard.get(&resp.frame_id).unwrap().clone_for_test();

        let mut mobile_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut mobile_bytes);
        let mobile_secret = StaticSecret::from(mobile_bytes);
        let mobile_pub_hex = hex::encode(PublicKey::from(&mobile_secret).as_bytes());

        let envelope_bytes =
            seal_seed_frame(&frame, &mobile_pub_hex, "did:key:attacker", b"seed").unwrap();
        let envelope: SealedSeedEnvelope = serde_json::from_slice(&envelope_bytes).unwrap();

        let shared = mobile_secret.diffie_hellman(&pub_from_hex(&frame.ephemeral_pub_hex));
        let hk = Hkdf::<Sha256>::new(Some(&frame.nonce[..]), shared.as_bytes());
        let mut key = [0u8; 32];
        hk.expand(PAIRING_HKDF_INFO, &mut key).unwrap();
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();

        // Attempting to unwrap with a different DID (AAD mismatch) must fail.
        let iv = base64.decode(&envelope.iv_b64).unwrap();
        let ct = base64.decode(&envelope.ciphertext_b64).unwrap();
        let wrong_aad = format!("{}\0{}", "did:key:someoneelse", frame.frame_id);
        let result = cipher.decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &ct,
                aad: wrong_aad.as_bytes(),
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_seal_rejects_bad_inputs() {
        let state = PairFrameState::default();
        let resp = begin_pairing(&state).unwrap();
        let guard = state.frames.lock().unwrap();
        let frame = guard.get(&resp.frame_id).unwrap().clone_for_test();

        assert!(seal_seed_frame(&frame, "zzzz", "did:key:test", b"seed").is_err());
        assert!(seal_seed_frame(&frame, "abcd", "did:key:test", b"seed").is_err());
        assert!(seal_seed_frame(&frame, "abc", "   ", b"seed").is_err());
    }

    #[test]
    fn test_each_begin_pairing_is_unique() {
        let state = PairFrameState::default();
        let a = begin_pairing(&state).unwrap();
        let b = begin_pairing(&state).unwrap();
        assert_ne!(a.frame_id, b.frame_id);
        // Pruning should leave exactly two live frames.
        let guard = state.frames.lock().unwrap();
        assert_eq!(guard.len(), 2);
    }
}