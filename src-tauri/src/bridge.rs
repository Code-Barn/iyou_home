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

use futures_util::{SinkExt, StreamExt};
use serde_json;

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;

use std::sync::Arc;

use crate::certs::{resolve_tls_assets, ReadBuffered};

use crate::WsState;

/// Upper bound on keys per RESOLVE_PEER_ALIASES frame (harvesting guard).
const MAX_RESOLVE_KEYS: usize = 256;

/// Public view of a stored persona profile exposed over the bridge. Deliberately
/// excludes `credentials` (which may contain raw W3C payloads) and any private
/// key material — only identity metadata crosses the wire.
#[derive(serde::Serialize)]
pub struct PublicPersonaSummary {
    pub profile_id: String,
    pub profile_name: String,
    /// Alias for `profile_name`, provided for `bridge_client.js` compatibility.
    pub name: String,
    pub did: String,
    pub derivation_index: u32,
    pub nostr_pubkey_hex: String,
    pub level: u8,
    pub active: bool,
}

impl From<&crate::vault::Profile> for PublicPersonaSummary {
    fn from(p: &crate::vault::Profile) -> Self {
        PublicPersonaSummary {
            profile_id: p.profile_id.clone(),
            profile_name: p.profile_name.clone(),
            name: p.profile_name.clone(),
            did: p.did.clone(),
            derivation_index: p.derivation_index,
            nostr_pubkey_hex: p.nostr_pubkey_hex.clone(),
            level: p.level,
            active: p.active,
        }
    }
}

/// Level 0 Air-Gap Invariant: profiles at derivation_index 0, level 0, or
/// flagged system-reserved are never exposed over the external bridge.
fn is_bridge_protected(profile: &crate::vault::Profile) -> bool {
    profile.derivation_index == 0 || profile.level == 0 || profile.is_system_reserved
}

/// Enumerate public summaries for every bridge-exposable persona (L1 and L2+).
pub fn public_persona_summaries(vault: &crate::vault::VaultStore) -> Vec<PublicPersonaSummary> {
    vault
        .profiles
        .iter()
        .filter(|p| !is_bridge_protected(p))
        .map(PublicPersonaSummary::from)
        .collect()
}

/// Resolve the profile targeted by a `set_active_profile`-style frame, supporting
/// both `profile_id` and `did` matching.
fn resolve_target_profile<'a>(
    vault: &'a crate::vault::VaultStore,
    profile_id: &str,
    did: &str,
) -> Option<&'a crate::vault::Profile> {
    if !profile_id.is_empty() {
        vault.profiles.iter().find(|p| p.profile_id == profile_id)
    } else if !did.is_empty() {
        vault.profiles.iter().find(|p| p.did == did)
    } else {
        None
    }
}

fn pipe_or_queue(app: &AppHandle, msg_json: serde_json::Value) {
    let state = app.state::<WsState>();
    let serialized = msg_json.to_string();
    let popup = state.popup_active.lock().unwrap();
    if *popup {
        state.pending_messages.lock().unwrap().push(serialized);
        println!("!!! CHALLENGE QUEUED — Popup already active !!!");
        return;
    }
    drop(popup);
    let pipe = state.challenge_channel.lock().unwrap();
    if let Some(channel) = pipe.as_ref() {
        let _ = channel.send(serialized);
        println!("!!! CHALLENGE PIPED TO REACT !!!");
    } else {
        state.pending_messages.lock().unwrap().push(serialized);
        println!("!!! CHALLENGE QUEUED — React pipe not registered yet !!!");
    }
}

/// Fail-closed access evaluation for external bridge frames. Returns the
/// denial reason when the request must not proceed. A vault that cannot be
/// loaded blocks ALL signing traffic — never fail open.
fn bridge_access_denial_reason(app: &AppHandle, profile_id: &str) -> Option<String> {
    let vault = match crate::vault::load_vault(app) {
        Ok(v) => v,
        Err(_) => {
            return Some("Access denied: Vault unavailable or uninitialized".to_string());
        }
    };

    // Empty/omitted profile_id resolves to the public persona downstream.
    if profile_id.is_empty() {
        return None;
    }

    if vault.dependents.iter().any(|d| d.dependent_id == profile_id) {
        return Some(
            "Access denied: Dependent identity is air-gapped from external signing".to_string(),
        );
    }

    match vault.get_profile_by_id(profile_id) {
        Some(p) if p.is_anchor() || p.is_system_reserved => Some(
            "Access denied: Level 0 identity is air-gapped from external signing".to_string(),
        ),
        _ => None,
    }
}

fn is_websocket_upgrade_request(data: &[u8]) -> bool {
    let text = String::from_utf8_lossy(data);
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() || !lines[0].starts_with("GET") {
        return false;
    }
    let lowercase_headers: Vec<String> = lines.iter().map(|l| l.trim().to_lowercase()).collect();

    let has_upgrade = lowercase_headers.iter().any(|l| l.starts_with("upgrade:"));
    let has_connection_upgrade = lowercase_headers
        .iter()
        .any(|l| l.starts_with("connection:") && l.contains("upgrade"));
    let has_ws_key = lowercase_headers
        .iter()
        .any(|l| l.starts_with("sec-websocket-key:"));

    has_upgrade && has_connection_upgrade && has_ws_key
}

async fn handle_ws_connection<S>(stream: S, app_handle: AppHandle)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let cors_callback = |req: &tauri::http::Request<()>, mut res: tauri::http::Response<()>| {
        println!("DEBUG: Handshake callback triggered");
        println!("DEBUG: Request method: {:?}", req.method());
        res.headers_mut().insert(
            "Access-Control-Allow-Origin",
            tauri::http::HeaderValue::from_static("*"),
        );
        res.headers_mut().insert(
            "Access-Control-Allow-Private-Network",
            tauri::http::HeaderValue::from_static("true"),
        );
        Ok(res)
    };

    let ws_stream = match accept_hdr_async(stream, cors_callback).await {
        Ok(ws) => {
            println!("DEBUG: WebSocket Upgrade Complete");
            ws
        }
        Err(e) => {
            eprintln!("WebSocket handshake failed: {}", e);
            return;
        }
    };

    let (response_tx, response_rx) = mpsc::unbounded_channel::<Message>();

    {
        let ws_state = app_handle.state::<WsState>();
        *ws_state.response_sender.lock().unwrap() = Some(response_tx.clone());
    }

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    let app_clone = app_handle.clone();
    tokio::spawn(async move {
        println!("DEBUG: Forwarder Task started");
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(10));
        tokio::pin!(response_rx);
        loop {
            tokio::select! {
                msg = response_rx.recv() => {
                    let msg = match msg {
                        Some(msg) => msg,
                        None => {
                            println!("DEBUG: Forwarder exit — response_rx channel closed (all senders dropped)");
                            break;
                        }
                    };
                    println!("Sending response over WebSocket: {:?}", msg);
                    if let Err(e) = ws_sender.send(msg).await {
                        eprintln!("DEBUG: Forwarder exit — ws_sender.send failed: {}", e);
                        break;
                    }
                    if let Err(e) = ws_sender.flush().await {
                        eprintln!("DEBUG: Forwarder exit — ws_sender.flush failed: {}", e);
                        break;
                    }
                }
                _ = heartbeat.tick() => {
                    if let Err(e) = ws_sender.send(Message::Ping(vec![])).await {
                        eprintln!("DEBUG: Forwarder exit — heartbeat ping failed: {}", e);
                        break;
                    }
                }
            }
        }
        // Force TCP buffer flush before clearing sender
        let _ = ws_sender.flush().await;
        // Add a generous buffer for the OS kernel to hand off the bytes
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let ws_state = app_clone.state::<WsState>();
        *ws_state.response_sender.lock().unwrap() = None;
        println!("DEBUG: Forwarder Task Exited — response_sender cleared");
    });

    while let Some(Ok(msg)) = ws_receiver.next().await {
        if msg.is_text() {
            let text = msg.to_text().unwrap().to_string();
            println!("Received Message: {:?}", text);
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                println!("DEBUG: Received JSON: {}", json);

                if json["type"] == "ping" {
                    println!("DEBUG: Ping received, sending pong via response_tx");
                    let _ = response_tx.send(Message::Text("{\"type\":\"pong\"}".into()));
                    continue;
                } else if json["type"] == "ENCLAVE_DIAGNOSTIC_QUERY"
                    || json["type"] == "DIAGNOSTIC_PROBE"
                    || json["type"] == "get_diagnostics"
                {
                    println!("DEBUG: ENCLAVE_DIAGNOSTIC_QUERY request received");
                    let diag = build_enclave_diagnostics(&app_handle);
                    let _ = response_tx.send(Message::Text(diag.to_string().into()));
                    continue;
                } else if json["type"] == "get_profile" {
                    println!("DEBUG: get_profile request received");
                    match crate::vault::load_vault(&app_handle) {
                        Ok(vault) => {
                            // Un-scoped sync only ever exposes the public
                            // persona (Level 1). The Level 0 anchor is
                            // air-gapped from external bridge callers.
                            let response = match vault.public_persona() {
                                Some(profile) => serde_json::json!({
                                    "type": "profile_sync",
                                    "profile": profile
                                }),
                                None => serde_json::json!({
                                    "type": "error",
                                    "message": "No public persona found in vault"
                                }),
                            };
                            let _ = response_tx.send(Message::Text(response.to_string().into()));
                        }
                        Err(e) => {
                            eprintln!("DEBUG: get_profile failed to load vault: {}", e);
                            let _ = response_tx.send(Message::Text(
                                serde_json::json!({
                                    "type": "error",
                                    "message": format!("Failed to load vault: {}", e)
                                }).to_string().into()
                            ));
                        }
                    }
                    continue;
                } else if json["type"] == "RESOLVE_PEER_ALIASES" {
                    println!("DEBUG: RESOLVE_PEER_ALIASES request received");
                    // Privacy safeguards: exact-match resolution only. The
                    // bridge never enumerates the contact book, responses
                    // carry solely nickname/badge for exact key hits, and
                    // query caps blunt brute-force harvesting.
                    match json.get("pubkeys").and_then(|v| v.as_array()) {
                        Some(keys) if !keys.is_empty() && keys.len() <= MAX_RESOLVE_KEYS => {
                            let queries: Vec<String> = keys
                                .iter()
                                .filter_map(|v| v.as_str())
                                .map(String::from)
                                .collect();
                            match crate::contacts::load_contact_store(&app_handle) {
                                Ok(store) => {
                                    let response =
                                        crate::contacts::resolution_json(&store, &queries);
                                    let _ = response_tx
                                        .send(Message::Text(response.to_string().into()));
                                }
                                Err(e) => {
                                    eprintln!("DEBUG: contact store failed to load: {}", e);
                                    let _ = response_tx.send(Message::Text(
                                        serde_json::json!({
                                            "type": "error",
                                            "message": format!("Failed to load contacts: {}", e)
                                        })
                                        .to_string()
                                        .into(),
                                    ));
                                }
                            }
                        }
                        Some(_) => {
                            // Oversized frame: reject outright (harvesting guard).
                            let _ = response_tx.send(Message::Text(
                                "{\"type\":\"error\",\"message\":\"too_many_pubkeys\"}".into(),
                            ));
                        }
                        None => {
                            let _ = response_tx.send(Message::Text(
                                "{\"type\":\"error\",\"message\":\"missing_or_invalid_pubkeys\"}"
                                    .into(),
                            ));
                        }
                    }
                    continue;
                } else if json["type"] == "list_profiles" || json["type"] == "LIST_PERSONAS" {
                    println!("DEBUG: list_profiles / LIST_PERSONAS request received");
                    match crate::vault::load_vault(&app_handle) {
                        Ok(vault) => {
                            let summaries = public_persona_summaries(&vault);
                            // `personas_list` is the type name the iyou_wun
                            // bridge_client.js recognizes; both `personas` and
                            // `profiles` keys are provided for compatibility.
                            let payload = serde_json::json!({
                                "type": "personas_list",
                                "personas": summaries,
                                "profiles": summaries,
                            });
                            let _ = response_tx.send(Message::Text(payload.to_string().into()));
                        }
                        Err(e) => {
                            eprintln!("DEBUG: list_profiles failed to load vault: {}", e);
                            let _ = response_tx.send(Message::Text(
                                serde_json::json!({
                                    "type": "error",
                                    "message": format!("Failed to load vault: {}", e)
                                }).to_string().into(),
                            ));
                        }
                    }
                    continue;
                } else if json["type"] == "set_active_profile"
                    || json["type"] == "SET_ACTIVE_PROFILE"
                    || json["type"] == "SET_ACTIVE_PERSONA"
                    || json["type"] == "switch_persona"
                {
                    println!("DEBUG: set_active_profile / SET_ACTIVE_PROFILE / switch_persona received");
                    let profile_id = json
                        .get("profile_id")
                        .and_then(|v| if v.is_null() { None } else { v.as_str() })
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let did = json
                        .get("did")
                        .and_then(|v| if v.is_null() { None } else { v.as_str() })
                        .unwrap_or("")
                        .trim()
                        .to_string();

                    if profile_id.is_empty() && did.is_empty() {
                        let _ = response_tx.send(Message::Text(
                            "{\"type\":\"error\",\"message\":\"missing_profile_id_or_did\"}".into(),
                        ));
                        continue;
                    }

                    // Fail-open to clean errors (never panic) if the vault cannot load.
                    let mut vault = match crate::vault::load_vault(&app_handle) {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("DEBUG: set_active_profile failed to load vault: {}", e);
                            let _ = response_tx.send(Message::Text(
                                serde_json::json!({
                                    "type": "error",
                                    "message": format!("Failed to load vault: {}", e)
                                }).to_string().into(),
                            ));
                            continue;
                        }
                    };

                    // Level 0 Air-Gap Invariant: never activate the anchor or any
                    // system-reserved identity over the bridge.
                    if let Some(target) = resolve_target_profile(&vault, &profile_id, &did) {
                        if is_bridge_protected(target) {
                            let _ = response_tx.send(Message::Text(
                                "{\"type\":\"error\",\"message\":\"Access denied: Level 0 identity is air-gapped from external activation\"}".into(),
                            ));
                            continue;
                        }
                    } else {
                        let _ = response_tx.send(Message::Text(
                            serde_json::json!({
                                "type": "error",
                                "message": format!(
                                    "Profile not found: profile_id='{}' did='{}'",
                                    profile_id, did
                                )
                            }).to_string().into(),
                        ));
                        continue;
                    }

                    let active_profile = match crate::vault::activate_persona(&mut vault, &profile_id) {
                        Ok(p) => p,
                        Err(e) => {
                            eprintln!("DEBUG: set_active_profile activation failed: {}", e);
                            let _ = response_tx.send(Message::Text(
                                serde_json::json!({
                                    "type": "error",
                                    "message": e
                                }).to_string().into(),
                            ));
                            continue;
                        }
                    };

                    if let Err(e) = crate::vault::save_vault(&app_handle, &vault) {
                        eprintln!("DEBUG: set_active_profile failed to persist vault: {}", e);
                        let _ = response_tx.send(Message::Text(
                            serde_json::json!({
                                "type": "error",
                                "message": format!("Failed to persist vault: {}", e)
                            }).to_string().into(),
                        ));
                        continue;
                    }

                    // Update in-memory active DID and preferences.
                    if let Some(service_state) = app_handle.try_state::<crate::ServiceState>() {
                        let mut active = service_state.active_did.lock().unwrap();
                        *active = Some(active_profile.did.clone());
                    }
                    let mut prefs = crate::load_preferences(&app_handle);
                    prefs.active_profile_id = active_profile.profile_id.clone();
                    prefs.active_sovereign_did = None;
                    let _ = crate::save_preferences(&app_handle, &prefs);
                    let _ = app_handle.emit("profile://changed", &active_profile);

                    let _ = response_tx.send(Message::Text(
                        serde_json::json!({
                            "type": "profile_sync",
                            "profile": {
                                "profile_id": active_profile.profile_id,
                                "profile_name": active_profile.profile_name,
                                "derivation_index": active_profile.derivation_index,
                                "did": active_profile.did,
                                "nostr_pubkey_hex": active_profile.nostr_pubkey_hex,
                                "level": active_profile.level,
                                "is_system_reserved": active_profile.is_system_reserved,
                                "active": true
                            }
                        }).to_string().into(),
                    ));
                    continue;
                }

                let raw_profile_id = json
                    .get("profile_id")
                    .and_then(|v| if v.is_null() { None } else { v.as_str() })
                    .unwrap_or("")
                    .trim();

                // Dynamic persona resolution: if profile_id is empty/omitted/null, resolve
                // to the currently active Vault profile (e.g. L2 DAD_BOD) rather than falling
                // back to L1 or erroring.
                let profile_id = if raw_profile_id.is_empty() {
                    crate::vault::load_vault(&app_handle)
                        .ok()
                        .and_then(|v| crate::vault::get_active_profile(&v).ok())
                        .map(|active_p| active_p.profile_id)
                        .unwrap_or_default()
                } else {
                    raw_profile_id.to_string()
                };

                // Enclave air-gap, fail-closed: external frames may never
                // target the Level 0 anchor, and an unloadable vault blocks
                // all signing traffic.
                if let Some(reason) = bridge_access_denial_reason(&app_handle, &profile_id) {
                    println!("DEBUG: Rejected bridge request: {}", reason);
                    let _ = response_tx.send(Message::Text(
                        serde_json::json!({
                            "type": "error",
                            "message": reason
                        })
                        .to_string()
                        .into(),
                    ));
                    continue;
                }

                let is_sign_raw = json["action"] == "sign_raw" || json["type"] == "sign_raw";
                let is_sign = json["action"] == "sign" || json["type"] == "sign" || is_sign_raw;
                if is_sign && (json["challenge"].is_string() || json["data"].is_string() || json["message"].is_string()) {
                    let challenge = json["challenge"]
                        .as_str()
                        .or_else(|| json["data"].as_str())
                        .or_else(|| json["message"].as_str())
                        .unwrap()
                        .to_string();
                    println!("Triggering Signature for Challenge/Data: {}", challenge);
                    println!("DEBUG: Signing with Ed25519 (OIDC/VP compliant) for profile '{}'", profile_id);

                    let app_handle = app_handle.clone();
                    tokio::spawn(async move {
                        let app = app_handle;

                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }

                        pipe_or_queue(
                            &app,
                            serde_json::json!({
                                "__type__": "sign",
                                "challenge": challenge,
                                "profile_id": profile_id
                            }),
                        );
                    });
                } else if json["type"] == "sign_event" || json["action"] == "sign_event" {
                    if json["event"].is_object() {
                        let event = json["event"].clone();
                        println!("Triggering Nostr Event signing for profile '{}'", profile_id);
                        println!("DEBUG: Signing Nostr event via secp256k1 Schnorr (NIP-01 standard)");

                        let app_handle = app_handle.clone();
                        tokio::spawn(async move {
                            let app = app_handle;

                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }

                            pipe_or_queue(
                                &app,
                                serde_json::json!({
                                    "__type__": "sign_event",
                                    "event": event,
                                    "profile_id": profile_id
                                }),
                            );
                        });
                    } else {
                        println!("DEBUG: Received sign_event without event object: {}", text);
                    }
                } else if json["type"] == "sign_credential" {
                    if json["credential"].is_object() {
                        let credential = json["credential"].clone();
                        let holder_did = if json["holder_did"].is_string() {
                            json["holder_did"].as_str().unwrap().to_string()
                        } else {
                        let default_did = crate::vault::load_vault(&app_handle)
                            .ok()
                            .and_then(|v| crate::vault::get_active_profile(&v).ok())
                            .map(|p| p.did)
                            .unwrap_or_else(|| "did:vault:unknown".to_string());
                        println!(
                            "DEBUG: No holder_did in message, defaulting to active persona DID: {}",
                            default_did
                        );
                            default_did
                        };
                        println!("Triggering Credential signing for holder: {}", holder_did);
                        println!("DEBUG: Signing VC with Ed25519 (issuer key)");

                        let app_handle = app_handle.clone();
                        tokio::spawn(async move {
                            let app = app_handle;

                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }

                            pipe_or_queue(
                                &app,
                                serde_json::json!({
                                    "__type__": "sign_credential",
                                    "credential": credential,
                                    "holder_did": holder_did,
                                    "profile_id": profile_id
                                }),
                            );
                        });
                    } else {
                        println!(
                            "DEBUG: Received sign_credential without credential object: {}",
                            text
                        );
                    }
                } else if json["type"] == "POLY_CREDENTIAL_REQUEST"
                    || json["type"] == "POLLY_CREDENTIAL_REQUEST"
                {
                    let required_type = json["required_credential_type"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    let challenge = json["challenge"]
                        .as_str()
                        .unwrap_or("")
                        .to_string();
                    if required_type.is_empty() || challenge.is_empty() {
                        println!("DEBUG: POLY_CREDENTIAL_REQUEST missing required_credential_type or challenge");
                        let _ = response_tx.send(Message::Text(
                            "{\"status\":\"error\",\"reason\":\"missing_required_fields\"}".into(),
                        ));
                        continue;
                    }
                    println!("Triggering Credential Presentation for type: {}", required_type);
                    let app_handle = app_handle.clone();
                    tokio::spawn(async move {
                        let app = app_handle;

                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }

                        pipe_or_queue(
                            &app,
                            serde_json::json!({
                                "__type__": "POLY_CREDENTIAL_REQUEST",
                                "required_credential_type": required_type,
                                "challenge": challenge,
                                "profile_id": profile_id
                            }),
                        );
                    });
                } else if json["type"] == "OMNI_SIGN_REQUEST" {
                    handle_omni_sign_request(json, &app_handle, &response_tx).await;
                } else if json["type"] == "SYNC_TO_HOME_REQUEST" {
                    // Sync-to-Home: batch-ingest Nostr events and mirror blobs
                    let events = json["events"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let blob_hashes = json["blob_hashes"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    let source_blossom_url = json["source_blossom_url"]
                        .as_str()
                        .unwrap_or("https://cdn.iyou.me")
                        .to_string();

                    // Resolve paths from AppHandle
                    let app_data = match app_handle.path().app_local_data_dir() {
                        Ok(p) => p,
                        Err(e) => {
                            let _ = response_tx.send(Message::Text(
                                serde_json::json!({
                                    "type": "error",
                                    "message": format!("Sync failed: {}", e)
                                }).to_string().into(),
                            ));
                            continue;
                        }
                    };

                    // 1. Ingest Nostr events into local SQLite
                    let db_path = app_data.join("nostr_events.db");
                    let mut events_ingested = 0usize;
                    if !events.is_empty() {
                        match rusqlite::Connection::open(&db_path) {
                            Ok(conn) => {
                                let db = std::sync::Arc::new(std::sync::Mutex::new(conn));
                                match crate::nostr_relay::ingest_batch_events(&events, &db) {
                                    Ok(n) => events_ingested = n,
                                    Err(e) => eprintln!("Sync: event ingestion failed: {}", e),
                                }
                            }
                            Err(e) => eprintln!("Sync: failed to open nostr db: {}", e),
                        }
                    }

                    // 2. Mirror blobs from upstream Blossom
                    let blobs_dir = app_data.join("blobs");
                    let _ = std::fs::create_dir_all(&blobs_dir);
                    let mut blobs_mirrored = 0usize;
                    for hash_val in &blob_hashes {
                        if let Some(hash) = hash_val.as_str() {
                            if let Ok(true) = crate::blossom::mirror_blob_from_remote(
                                hash,
                                &source_blossom_url,
                                &blobs_dir,
                            ).await {
                                blobs_mirrored += 1;
                            }
                        }
                    }

                    // 3. Update last_synced_at timestamp
                    let now = chrono::Utc::now().timestamp() as u64;
                    {
                        let mut prefs = crate::load_preferences(&app_handle);
                        prefs.last_synced_at = now;
                        let _ = crate::save_preferences(&app_handle, &prefs);
                    }

                    let _ = response_tx.send(Message::Text(
                        serde_json::json!({
                            "type": "sync_to_home_completed",
                            "events_ingested": events_ingested,
                            "blobs_mirrored": blobs_mirrored,
                            "last_synced_at": now
                        }).to_string().into(),
                    ));
                } else {
                    println!("DEBUG: Received unknown JSON structure: {}", text);
                }
            }
        } else if msg.is_pong() {
            println!("Heartbeat Pong received");
        }
    }
    println!("DEBUG: WebSocket Read Loop Exited");

    let ws_state = app_handle.state::<WsState>();
    *ws_state.response_sender.lock().unwrap() = None;
}

async fn handle_connection<S>(mut stream: S, app_handle: AppHandle)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut head = vec![0u8; 4096];
    let n = match stream.read(&mut head).await {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };

    let data = &head[..n];

    if data.starts_with(b"OPTIONS") {
        println!("OPTIONS pre-flight received (TLS)");
        let response = b"HTTP/1.1 200 OK\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Private-Network: true\r\n\
            Access-Control-Allow-Methods: GET, PUT, POST, OPTIONS\r\n\
            Access-Control-Allow-Headers: *\r\n\
            Content-Length: 0\r\n\
            Connection: keep-alive\r\n\r\n";
        let _ = stream.write_all(response).await;
    } else if is_websocket_upgrade_request(data) {
        let buffered = ReadBuffered::new(stream, head[..n].to_vec());
        handle_ws_connection(buffered, app_handle).await;
    }
}

async fn listen_on(addrs: &str, app: AppHandle) {
    // SEC-002: TLS assets resolve strictly at runtime from the app data dir
    // (or fall back to an ephemeral local authority). No compile-time keys.
    let cert_dir = match app.path().app_local_data_dir() {
        Ok(dir) => dir.join("certs"),
        Err(e) => {
            eprintln!(
                "Signature Bridge cannot resolve cert directory (fail-closed, NOT started): {}",
                e
            );
            return;
        }
    };
    let (certs, key) = match resolve_tls_assets(&cert_dir) {
        Ok(assets) => assets,
        Err(e) => {
            eprintln!("Signature Bridge TLS failure (fail-closed, NOT started): {}", e);
            return;
        }
    };

    let config = match ServerConfig::builder_with_provider(Arc::new(tokio_rustls::rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())
        .and_then(|b| b.with_no_client_auth().with_single_cert(certs, key).map_err(|e| e.to_string()))
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Signature Bridge TLS config rejected (fail-closed): {}", e);
            return;
        }
    };

    let acceptor = TlsAcceptor::from(Arc::new(config));

    let listener = TcpListener::bind(addrs)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind WSS on {}: {}", addrs, e));
    println!("Signature Bridge listening on wss://home.iyou.me:9001");

    while let Ok((stream, peer)) = listener.accept().await {
        println!("TCP Connection received from: {:?}", peer);
        let acceptor = acceptor.clone();
        let app_handle = app.clone();
        tokio::spawn(async move {
            match acceptor.accept(stream).await {
                Ok(tls_stream) => {
                    handle_connection(tls_stream, app_handle).await;
                }
                Err(e) => {
                    eprintln!("TLS handshake failed from {:?}: {}", peer, e);
                }
            }
        });
    }
}

async fn handle_omni_sign_request(
    json: serde_json::Value,
    app_handle: &AppHandle,
    response_tx: &mpsc::UnboundedSender<Message>,
) {
    let protocol = json["protocol"].as_str().unwrap_or("");
    // Accept both canonical POLY_V2 and legacy POLLY_V2 spellings; the
    // response always echoes the protocol the caller used.
    if protocol != "POLY_V2" && protocol != "POLLY_V2" {
        println!("OMNI_SIGN_REQUEST rejected: unknown protocol '{}'", protocol);
        let _ = response_tx.send(Message::Text(
            "{\"status\":\"error\",\"reason\":\"unsupported_protocol\"}".into(),
        ));
        return;
    }

    let payload = match json.get("payload").and_then(|p| p.as_object()) {
        Some(p) => p,
        None => {
            let _ = response_tx.send(Message::Text(
                "{\"status\":\"error\",\"reason\":\"missing_payload\"}".into(),
            ));
            return;
        }
    };

    let payload_value = serde_json::Value::Object(payload.clone());
    let profile_id = json
        .get("profile_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let protocol_out = protocol.to_string();

    let app = app_handle.clone();
    let tx = response_tx.clone();
    tokio::spawn(async move {
        match crate::sign_omni_payload(&app, &payload_value, profile_id) {
            Ok(envelope) => {
                let response = serde_json::json!({
                    "type": "OMNI_SIGN_RESPONSE",
                    "protocol": protocol_out,
                    "envelope": envelope,
                });
                println!("OMNI_SIGN_REQUEST signed successfully");
                let _ = tx.send(Message::Text(response.to_string().into()));
            }
            Err(e) => {
                eprintln!("OMNI_SIGN_REQUEST signing failed: {}", e);
                let err = serde_json::json!({
                    "status": "error",
                    "reason": e,
                });
                let _ = tx.send(Message::Text(err.to_string().into()));
            }
        }
    });
}

pub async fn start_ws_server(app: AppHandle) {
    listen_on("127.0.0.1:9001", app).await;
}

/// Build enclave diagnostics for loopback diagnostic probing without exposing private keys.
pub fn build_enclave_diagnostics(app: &AppHandle) -> serde_json::Value {
    let now = chrono::Utc::now().timestamp() as u64;

    // 1. Key Custody
    let (key_custody_init, anchor_init, persona_init, active_did, profile_count, sovereign_count) =
        match crate::vault::load_vault(app) {
            Ok(v) => {
                let has_anchor = v.profiles.iter().any(|p| p.is_anchor());
                let has_persona = v.public_persona().is_some();
                let did = v
                    .public_persona()
                    .map(|p| p.did.clone())
                    .unwrap_or_default();
                let count = v.profiles.len();
                let sov_count = v.sovereign_identities.len();
                (has_anchor && has_persona, has_anchor, has_persona, did, count, sov_count)
            }
            Err(_) => (false, false, false, String::new(), 0, 0),
        };

    // 2. Local Services & App data dir
    let app_data = app.path().app_local_data_dir().ok();

    let (nostr_running, blossom_running, chat_running) =
        if let Some(state) = app.try_state::<crate::ServiceState>() {
            let services = state.services.lock().unwrap();
            (
                services.get("Nostr") == Some(&crate::ServiceStatus::Running),
                services.get("Blossom") == Some(&crate::ServiceStatus::Running),
                services.get("Chat") == Some(&crate::ServiceStatus::Running),
            )
        } else {
            (false, false, false)
        };

    let nostr_diag = if let Some(ref dir) = app_data {
        crate::nostr_relay::probe_relay_status(dir)
    } else {
        serde_json::json!({ "status": "unavailable", "port": 9003, "events_count": 0, "db_exists": false })
    };

    let blossom_diag = if let Some(ref dir) = app_data {
        crate::blossom::probe_blossom_status(&dir.join("blobs"))
    } else {
        serde_json::json!({ "status": "unavailable", "port": 9002, "blobs_count": 0, "storage_bytes": 0 })
    };

    // 3. Preferences & Relays & Backups
    let prefs = crate::load_preferences(app);
    let relay_mesh = prefs.relay_mesh.clone();
    let mesh_count = relay_mesh.len();
    let mesh_ready = mesh_count >= 3;

    let last_backup_at = prefs.last_backup_at;
    let is_fresh = last_backup_at > 0 && (now.saturating_sub(last_backup_at)) < (30 * 86400);
    let days_since_backup = if last_backup_at > 0 {
        Some((now.saturating_sub(last_backup_at)) / 86400)
    } else {
        None
    };

    let all_capabilities_met = key_custody_init
        && nostr_running
        && blossom_running
        && mesh_ready
        && is_fresh;

    serde_json::json!({
        "type": "ENCLAVE_DIAGNOSTIC_RESPONSE",
        "status": "ok",
        "timestamp": now,
        "key_custody": {
            "initialized": key_custody_init,
            "anchor_initialized": anchor_init,
            "public_persona_initialized": persona_init,
            "active_did": active_did,
            "profile_count": profile_count,
            "sovereign_identities_count": sovereign_count,
            "status": if key_custody_init { "active" } else { "uninitialized" }
        },
        "local_ingress_relay": {
            "service_name": "Nostr",
            "port": 9003,
            "running": nostr_running,
            "db_exists": nostr_diag["db_exists"].as_bool().unwrap_or(false),
            "events_count": nostr_diag["events_count"].as_u64().unwrap_or(0),
            "status": if nostr_running { "running" } else { "stopped" }
        },
        "local_media_server": {
            "service_name": "Blossom",
            "port": 9002,
            "protocol": "BUD-01",
            "running": blossom_running,
            "blobs_count": blossom_diag["blobs_count"].as_u64().unwrap_or(0),
            "storage_bytes": blossom_diag["storage_bytes"].as_u64().unwrap_or(0),
            "status": if blossom_running { "running" } else { "stopped" }
        },
        "local_chat_daemon": {
            "service_name": "Chat",
            "port": 5222,
            "running": chat_running,
            "status": if chat_running { "running" } else { "stopped" }
        },
        "relay_gossip_mesh": {
            "relays": relay_mesh,
            "min_required": 3,
            "configured_count": mesh_count,
            "mesh_ready": mesh_ready,
            "status": if mesh_ready { "healthy" } else { "insufficient_relays" }
        },
        "encrypted_backups": {
            "last_backup_at": last_backup_at,
            "days_since_backup": days_since_backup,
            "is_fresh": is_fresh,
            "seed_backup_confirmed": prefs.seed_backup_confirmed,
            "status": if is_fresh { "fresh" } else if last_backup_at == 0 { "never_exported" } else { "stale" }
        },
        "all_capabilities_met": all_capabilities_met
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{activate_persona, DependentProfile, Profile, VaultStore};

    fn sample_profile(
        profile_id: &str,
        derivation_index: u32,
        level: u8,
        is_system_reserved: bool,
        active: bool,
    ) -> Profile {
        Profile {
            profile_id: profile_id.to_string(),
            profile_name: format!("{} Persona", profile_id),
            derivation_index,
            did: format!("did:key:z6Mk{}", profile_id),
            credentials: vec![],
            nostr_pubkey_hex: "abcd".repeat(16),
            level,
            is_system_reserved,
            active,
            imported_seed_b58: None,
            imported_nostr_sk_hex: None,
        }
    }

    fn test_vault() -> VaultStore {
        // Anchor (L0 / index 0 / system-reserved), Primary (L1 / index 1),
        // and a couple of L2 burners.
        VaultStore {
            root_seed_base58: "seed".to_string(),
            profiles: vec![
                sample_profile("anchor", 0, 0, true, false),
                sample_profile("primary", 1, 1, false, true),
                sample_profile("dad_bod", 2, 2, false, false),
                sample_profile("work_sock", 3, 2, false, false),
            ],
            sovereign_identities: vec![],
            dependents: vec![],
        }
    }

    #[test]
    fn test_list_profiles_excludes_level0_anchor() {
        let vault = test_vault();
        let summaries = public_persona_summaries(&vault);

        // Only L1 + L2 personas are exposed; the Level 0 anchor is filtered out.
        assert_eq!(summaries.len(), 3);
        let ids: Vec<&str> = summaries.iter().map(|s| s.profile_id.as_str()).collect();
        assert!(!ids.contains(&"anchor"));
        assert!(ids.contains(&"primary"));
        assert!(ids.contains(&"dad_bod"));
        assert!(ids.contains(&"work_sock"));

        // The summary omits private credential material but includes the
        // public identity metadata and the `name` alias.
        let primary = summaries.iter().find(|s| s.profile_id == "primary").unwrap();
        assert_eq!(primary.name, primary.profile_name);
        assert_eq!(primary.derivation_index, 1);
        assert_eq!(primary.level, 1);
        assert!(primary.active);
        assert!(primary.did.starts_with("did:key:"));
    }

    #[test]
    fn test_is_bridge_protected_predictates() {
        // Each independent Level 0 invariant must trip the guard.
        assert!(is_bridge_protected(&sample_profile("a", 0, 1, false, false)));
        assert!(is_bridge_protected(&sample_profile("b", 1, 0, false, false)));
        assert!(is_bridge_protected(&sample_profile("c", 1, 1, true, false)));
        // L1 / L2 personas are never protected.
        assert!(!is_bridge_protected(&sample_profile("d", 1, 1, false, false)));
        assert!(!is_bridge_protected(&sample_profile("e", 2, 2, false, false)));
    }

    #[test]
    fn test_activate_level0_fails_cleanly_without_panic() {
        let mut vault = test_vault();

        // Attempting to activate the Level 0 anchor fails cleanly with an
        // error rather than panicking or mutating state.
        let err = activate_persona(&mut vault, "anchor");
        assert!(err.is_err());
        let msg = err.unwrap_err();
        assert!(
            msg.to_lowercase().contains("anchor"),
            "Expected anchor rejection, got: {}",
            msg
        );

        // The anchor may never become active.
        assert!(!vault.profiles[0].active);
        // The previous active persona remains active.
        assert!(vault.profiles[1].active);
    }

    #[test]
    fn test_activate_invalid_profile_fails_cleanly() {
        let mut vault = test_vault();
        let err = activate_persona(&mut vault, "does_not_exist");
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("not found"));

        // State must be unchanged after a failed activation.
        assert_eq!(vault.profiles[0].active, false);
        assert!(vault.profiles[1].active);
    }

    #[test]
    fn test_activate_l2_burner_succeeds_and_broadcast_shape() {
        let mut vault = test_vault();
        let active = activate_persona(&mut vault, "dad_bod")
            .expect("L2 burner activation must succeed");

        assert_eq!(active.profile_id, "dad_bod");
        assert!(active.active);
        assert_eq!(active.level, 2);

        // Emit the profile_sync JSON the bridge broadcasts after activation.
        let sync = serde_json::json!({
            "type": "profile_sync",
            "profile": {
                "profile_id": active.profile_id,
                "profile_name": active.profile_name,
                "derivation_index": active.derivation_index,
                "did": active.did,
                "nostr_pubkey_hex": active.nostr_pubkey_hex,
                "level": active.level,
                "is_system_reserved": active.is_system_reserved,
                "active": true
            }
        });
        assert_eq!(sync["type"], "profile_sync");
        assert_eq!(sync["profile"]["profile_id"], "dad_bod");
        assert_eq!(sync["profile"]["derivation_index"], 2);
        assert_eq!(sync["profile"]["level"], 2);
        assert_eq!(sync["profile"]["active"], true);
    }

    #[test]
    fn test_resolve_target_profile_by_id_and_did() {
        let vault = test_vault();

        let by_id = resolve_target_profile(&vault, "work_sock", "").unwrap();
        assert_eq!(by_id.profile_id, "work_sock");

        let by_did = resolve_target_profile(&vault, "", "did:key:z6Mkwork_sock").unwrap();
        assert_eq!(by_did.profile_id, "work_sock");

        assert!(resolve_target_profile(&vault, "", "").is_none());
        assert!(resolve_target_profile(&vault, "nope", "").is_none());
    }

    #[test]
    fn test_resolve_target_profile_ignores_dependents() {
        let mut vault = test_vault();
        vault.dependents.push(DependentProfile {
            dependent_id: "dep_alice_12345678".to_string(),
            name: "Alice".to_string(),
            birth_year: 2012,
            custody_stage: 1,
            dependent_index: 0,
            did: "did:key:z6MkAliceDependent".to_string(),
            nostr_pubkey_hex: "abcd".repeat(16),
            guardian_did: "did:key:z6Mkprimary".to_string(),
            allowed_relays: vec![],
            attestation_vc: None,
            revoked: false,
            created_at: 1000,
            graduated_at: None,
        });

        assert!(resolve_target_profile(&vault, "dep_alice_12345678", "").is_none());
        assert!(resolve_target_profile(&vault, "", "did:key:z6MkAliceDependent").is_none());
    }
}
