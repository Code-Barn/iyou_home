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

//! Dual-mode mobile pairing transport: Nostr relay signaling and air-gapped QR fallback.
//!
//! Provides the network adapter allowing `iyou_mobile_swift` to exchange ephemeral
//! X25519 public keys and receive a sealed root master seed envelope either over
//! an encrypted Nostr signaling channel (`wss://relay.iyou.me`) or through an
//! offline two-way QR scan exchange.

use futures_util::{SinkExt, StreamExt};
use k256::schnorr::SigningKey as SecpSigningKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::{AppHandle, Emitter as _, Manager};
use tokio_tungstenite::tungstenite::Message;

use crate::pairing::{self, SealedSeedEnvelope};

/// Kind 24133 is the ephemeral encrypted device pairing handshake event.
pub const NOSTR_KIND_PAIRING: u64 = 24133;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineSealedResponse {
    pub envelope: SealedSeedEnvelope,
    pub sealed_qr_png_b64: String,
    pub sealed_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayStatusPayload {
    pub frame_id: String,
    pub status: String, // "connecting" | "connected" | "offline" | "completed" | "error"
    pub relay: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Shared processor for incoming mobile handshake payloads (from either relay or offline QR).
pub fn handle_incoming_mobile_handshake(
    app: &AppHandle,
    state: &pairing::PairFrameState,
    frame_id: &str,
    mobile_x25519_pub_hex: &str,
    device_did: &str,
    device_name: &str,
    verification_code: &str,
) -> Result<SealedSeedEnvelope, String> {
    let frame_id = frame_id.trim();
    let mobile_x25519_pub_hex = mobile_x25519_pub_hex.trim();
    let device_did = device_did.trim();
    let device_name = device_name.trim();
    let verification_code = verification_code.trim().to_uppercase();

    if frame_id.is_empty() {
        return Err("frame_id must not be empty".to_string());
    }
    if mobile_x25519_pub_hex.is_empty() {
        return Err("mobile_x25519_pub_hex must not be empty".to_string());
    }
    if device_did.is_empty() {
        return Err("device_did must not be empty".to_string());
    }
    if device_name.is_empty() {
        return Err("device_name must not be empty".to_string());
    }
    if verification_code.is_empty() {
        return Err("verification_code must not be empty".to_string());
    }

    // 1. Seal root seed for device (validates TTL, consumes active frame, and enforces code check)
    let sealed_bytes = pairing::seal_seed_for_device(
        app,
        state,
        frame_id,
        mobile_x25519_pub_hex,
        device_did,
        &verification_code,
    )?;

    let envelope: SealedSeedEnvelope = serde_json::from_slice(&sealed_bytes)
        .map_err(|e| format!("Failed to parse sealed seed envelope: {}", e))?;

    // 2. Confirm pairing in pairing store and emit pair://status
    let _ = pairing::confirm_pairing(app, state, frame_id, device_did, device_name)?;

    Ok(envelope)
}

/// Parse user-submitted offline response string into constituent parameters.
/// Accepts either an `iyouhome://pair-ack?...` deep link URI or a JSON object.
pub fn parse_offline_response_input(
    input: &str,
) -> Result<(String, String, String, String, String), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Offline pairing response input must not be empty".to_string());
    }

    // JSON payload detection
    if trimmed.starts_with('{') {
        let val: serde_json::Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("Invalid JSON response format: {}", e))?;
        let frame_id = val
            .get("frame_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let x25519 = val
            .get("mobile_x25519_pub_hex")
            .or_else(|| val.get("x25519"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let did = val
            .get("device_did")
            .or_else(|| val.get("did"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let name = val
            .get("device_name")
            .or_else(|| val.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("Mobile Companion")
            .trim()
            .to_string();
        let code = val
            .get("verification_code")
            .or_else(|| val.get("code"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_uppercase();

        if frame_id.is_empty() {
            return Err("JSON payload missing 'frame_id'".to_string());
        }
        if x25519.is_empty() {
            return Err("JSON payload missing 'x25519' (mobile public key)".to_string());
        }
        if did.is_empty() {
            return Err("JSON payload missing 'device_did'".to_string());
        }
        if code.is_empty() {
            return Err("JSON payload missing 'verification_code'".to_string());
        }

        return Ok((frame_id, x25519, did, name, code));
    }

    // URI query string parser
    let query_part = if let Some((_, q)) = trimmed.split_once('?') {
        q
    } else {
        trimmed
    };

    let mut frame_id = String::new();
    let mut x25519 = String::new();
    let mut did = String::new();
    let mut name = "Mobile Companion".to_string();
    let mut code = String::new();

    for pair in query_part.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let val = pairing::percent_decode(v).unwrap_or_else(|_| v.to_string());
            match k.trim().to_lowercase().as_str() {
                "frame_id" => frame_id = val.trim().to_string(),
                "x25519" | "mobile_x25519" | "mobile_x25519_pub_hex" => {
                    x25519 = val.trim().to_string()
                }
                "did" | "device_did" => did = val.trim().to_string(),
                "name" | "device_name" => name = val.trim().to_string(),
                "code" | "verification_code" => code = val.trim().to_uppercase(),
                _ => {}
            }
        }
    }

    if frame_id.is_empty() {
        return Err("URI query missing 'frame_id'".to_string());
    }
    if x25519.is_empty() {
        return Err("URI query missing 'x25519' parameter".to_string());
    }
    if did.is_empty() {
        return Err("URI query missing 'did' parameter".to_string());
    }
    if code.is_empty() {
        return Err("URI query missing 'code' parameter".to_string());
    }

    Ok((frame_id, x25519, did, name, code))
}

/// Sign a Nostr event using an ephemeral secp256k1 keypair.
fn build_signed_nostr_event(
    signing_key: &SecpSigningKey,
    kind: u64,
    tags: Vec<Vec<String>>,
    content: &str,
) -> Result<serde_json::Value, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let pubkey_hex = hex::encode(signing_key.verifying_key().to_bytes());
    let serialized_prehash = serde_json::to_string(&serde_json::json!([
        0,
        pubkey_hex,
        now,
        kind,
        tags,
        content
    ]))
    .map_err(|e| format!("Failed to serialize prehash: {}", e))?;

    let hash: [u8; 32] = Sha256::digest(serialized_prehash.as_bytes()).into();
    let id_hex = hex::encode(hash);

    let schnorr_sig = signing_key
        .sign_raw(&hash, &Default::default())
        .map_err(|_| "Schnorr signing failed".to_string())?;
    let sig_hex = hex::encode(schnorr_sig.to_bytes());

    Ok(serde_json::json!({
        "id": id_hex,
        "pubkey": pubkey_hex,
        "created_at": now,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": sig_hex,
    }))
}

/// Ephemeral background listener connected to `wss://relay.iyou.me`.
/// Subscribes to kind 24133 handshake events targeted for `frame_id`.
pub async fn start_pairing_relay_listener(
    app: AppHandle,
    frame_id: String,
    relay_url: String,
    mut cancel_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let emit_status = |status: &str, message: Option<String>| {
        let _ = app.emit(
            "pair://relay-status",
            RelayStatusPayload {
                frame_id: frame_id.clone(),
                status: status.to_string(),
                relay: relay_url.clone(),
                message,
            },
        );
    };

    emit_status("connecting", Some("Connecting to relay...".to_string()));

    let ws_stream = match tokio_tungstenite::connect_async(&relay_url).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            eprintln!(
                "[iyou_home] Pairing relay connection failed ({}) — fallback to offline QR mode",
                e
            );
            emit_status(
                "offline",
                Some("Relay unreachable — use Air-Gapped QR Response".to_string()),
            );
            return;
        }
    };

    emit_status(
        "connected",
        Some("Listening on relay.iyou.me for companion handshake".to_string()),
    );

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Subscribe to events: ["REQ", "pair_<frame_id>", {"kinds": [24133], "#d": [frame_id]}]
    let sub_id = format!("pair_{}", frame_id);
    let req_msg = serde_json::json!([
        "REQ",
        sub_id,
        {
            "kinds": [NOSTR_KIND_PAIRING],
            "#d": [frame_id]
        }
    ]);

    if let Err(e) = ws_sender
        .send(Message::Text(req_msg.to_string()))
        .await
    {
        eprintln!("[iyou_home] Failed to subscribe to pairing relay: {}", e);
        emit_status("offline", Some("Relay subscription error".to_string()));
        return;
    }

    let timeout_duration = Duration::from_secs(pairing::PAIR_FRAME_TTL_SECS);
    tokio::pin! {
        let timeout_sleep = tokio::time::sleep(timeout_duration);
    }

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                // Cancelled by user closing modal or completing offline
                let close_msg = serde_json::json!(["CLOSE", sub_id]);
                let _ = ws_sender.send(Message::Text(close_msg.to_string())).await;
                break;
            }
            _ = &mut timeout_sleep => {
                emit_status("offline", Some("Pairing frame expired".to_string()));
                break;
            }
            msg = ws_receiver.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    _ => break,
                };

                if let Message::Text(text) = msg {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        if val.get(0).and_then(|v| v.as_str()) == Some("EVENT")
                            && val.get(1).and_then(|v| v.as_str()) == Some(&sub_id)
                        {
                            if let Some(event) = val.get(2) {
                                if event.get("kind").and_then(|k| k.as_u64()) == Some(NOSTR_KIND_PAIRING) {
                                    if let Some(content_str) = event.get("content").and_then(|c| c.as_str()) {
                                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(content_str) {
                                            let mobile_x25519 = parsed.get("mobile_x25519_pub_hex")
                                                .or_else(|| parsed.get("x25519"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            let device_did = parsed.get("device_did")
                                                .or_else(|| parsed.get("did"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            let device_name = parsed.get("device_name")
                                                .or_else(|| parsed.get("name"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("Mobile Companion");
                                            let verification_code = parsed.get("verification_code")
                                                .or_else(|| parsed.get("code"))
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");
                                            let mobile_pubkey = event.get("pubkey").and_then(|p| p.as_str()).unwrap_or("");

                                            let state = app.state::<pairing::PairFrameState>();
                                            match handle_incoming_mobile_handshake(
                                                &app,
                                                &state,
                                                &frame_id,
                                                mobile_x25519,
                                                device_did,
                                                device_name,
                                                verification_code,
                                            ) {
                                                Ok(envelope) => {
                                                    // Generate an ephemeral keypair to sign the outgoing envelope
                                                    let ephemeral_signing_key = SecpSigningKey::random(&mut OsRng);
                                                    let envelope_json = serde_json::to_string(&envelope).unwrap_or_default();
                                                    let tags = vec![
                                                        vec!["d".to_string(), frame_id.clone()],
                                                        vec!["p".to_string(), mobile_pubkey.to_string()],
                                                    ];

                                                    if let Ok(signed_event) = build_signed_nostr_event(
                                                        &ephemeral_signing_key,
                                                        NOSTR_KIND_PAIRING,
                                                        tags,
                                                        &envelope_json,
                                                    ) {
                                                        let out_msg = serde_json::json!(["EVENT", signed_event]);
                                                        let _ = ws_sender.send(Message::Text(out_msg.to_string())).await;
                                                    }

                                                    emit_status(
                                                        "completed",
                                                        Some("Mobile companion paired successfully via relay".to_string()),
                                                    );
                                                    break;
                                                }
                                                Err(e) => {
                                                    eprintln!("[iyou_home] Mobile handshake rejected: {}", e);
                                                    emit_status("error", Some(format!("Handshake failed: {}", e)));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_offline_response_from_uri() {
        let uri = "iyouhome://pair-ack?frame_id=abc-123&x25519=deadbeef01020304deadbeef01020304deadbeef01020304deadbeef01020304&did=did%3Akey%3Az6MkuTest123&name=My%20iPhone&code=7K9X2M";
        let (frame_id, x25519, did, name, code) = parse_offline_response_input(uri).expect("URI must parse");
        assert_eq!(frame_id, "abc-123");
        assert_eq!(x25519, "deadbeef01020304deadbeef01020304deadbeef01020304deadbeef01020304");
        assert_eq!(did, "did:key:z6MkuTest123");
        assert_eq!(name, "My iPhone");
        assert_eq!(code, "7K9X2M");
    }

    #[test]
    fn test_parse_offline_response_from_json() {
        let json = r#"{
            "frame_id": "frame-xyz-456",
            "mobile_x25519_pub_hex": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
            "device_did": "did:key:z6MkuSmash123",
            "device_name": "Smashphone Pro",
            "verification_code": "234567"
        }"#;
        let (frame_id, x25519, did, name, code) = parse_offline_response_input(json).expect("JSON must parse");
        assert_eq!(frame_id, "frame-xyz-456");
        assert_eq!(x25519, "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");
        assert_eq!(did, "did:key:z6MkuSmash123");
        assert_eq!(name, "Smashphone Pro");
        assert_eq!(code, "234567");
    }

    #[test]
    fn test_parse_offline_response_rejects_missing_fields() {
        assert!(parse_offline_response_input("").is_err());
        assert!(parse_offline_response_input("iyouhome://pair-ack?frame_id=abc").is_err());
        assert!(parse_offline_response_input(r#"{"frame_id":"abc"}"#).is_err());
    }

    #[test]
    fn test_build_signed_nostr_event() {
        let key = SecpSigningKey::random(&mut OsRng);
        let tags = vec![
            vec!["d".to_string(), "test-frame-777".to_string()],
            vec!["p".to_string(), "recipient-pubkey".to_string()],
        ];
        let content = r#"{"test":"payload"}"#;
        let event = build_signed_nostr_event(&key, NOSTR_KIND_PAIRING, tags, content)
            .expect("signing must succeed");

        assert_eq!(event["kind"], NOSTR_KIND_PAIRING);
        assert_eq!(event["content"], content);
        assert_eq!(event["tags"][0][1], "test-frame-777");
        assert!(event["id"].as_str().unwrap().len() == 64);
        assert!(event["sig"].as_str().unwrap().len() == 128);
    }
}
