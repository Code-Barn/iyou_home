/*
 * Copyright (C) 2026 Byers Brands, LLC
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
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

pub async fn start_relay(
    db_path: PathBuf,
    listener: TcpListener,
    mut shutdown_rx: watch::Receiver<bool>,
    vault_pubkey_b64: String,
) {
    let db = match init_db(&db_path) {
        Ok(db) => Arc::new(Mutex::new(db)),
        Err(e) => {
            eprintln!("Nostr relay DB init failed: {}", e);
            return;
        }
    };

    println!("Nostr relay listening on :9003");

    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, peer)) => {
                        println!("Nostr relay connection from {:?}", peer);
                        let db = db.clone();
                        let pubkey = vault_pubkey_b64.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, db, pubkey).await;
                        });
                    }
                    Err(e) => {
                        eprintln!("Nostr relay accept error: {}", e);
                    }
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    println!("Nostr relay shutting down");
                    break;
                }
            }
        }
    }
}

fn init_db(path: &PathBuf) -> Result<rusqlite::Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            pubkey TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            kind INTEGER NOT NULL,
            tags TEXT NOT NULL,
            content TEXT NOT NULL,
            sig TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
        CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
        CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

async fn handle_connection(
    stream: TcpStream,
    db: Arc<Mutex<rusqlite::Connection>>,
    vault_pubkey_b64: String,
) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("Nostr WS handshake failed: {}", e);
            return;
        }
    };

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let mut subscriptions: Vec<String> = Vec::new();

    while let Some(Ok(msg)) = ws_receiver.next().await {
        if !msg.is_text() {
            continue;
        }

        let text = msg.to_text().unwrap().to_string();
        let parsed: Result<Value, _> = serde_json::from_str(&text);

        let arr = match parsed {
            Ok(Value::Array(a)) => a,
            _ => {
                let _ = ws_sender
                    .send(Message::Text("[\"NOTICE\",\"Expected JSON array\"]".into()))
                    .await;
                continue;
            }
        };

        if arr.is_empty() {
            continue;
        }

        let msg_type = arr[0].as_str().unwrap_or("");

        match msg_type {
            "EVENT" => {
                if arr.len() < 2 {
                    continue;
                }
                let event = &arr[1];
                let result = verify_and_store_event(event, &db, &vault_pubkey_b64);
                match result {
                    Ok(event_id) => {
                        let ok = format!("[\"OK\",\"{}\",true,\"\"]", event_id);
                        let _ = ws_sender.send(Message::Text(ok.into())).await;
                    }
                    Err(e) => {
                        let ok = format!("[\"OK\",\"\",false,\"{}\"]", e);
                        let _ = ws_sender.send(Message::Text(ok.into())).await;
                    }
                }
            }
            "REQ" => {
                if arr.len() < 3 {
                    continue;
                }
                let sub_id = arr[1].as_str().unwrap_or("").to_string();
                let filters: Vec<Value> = arr.iter().skip(2).cloned().collect();

                let events = query_events(&db, &filters);
                for event_str in &events {
                    let msg = format!("[\"EVENT\",\"{}\",{}]", sub_id, event_str);
                    let _ = ws_sender.send(Message::Text(msg.into())).await;
                }
                let eose = format!("[\"EOSE\",\"{}\"]", sub_id);
                let _ = ws_sender.send(Message::Text(eose.into())).await;
                subscriptions.push(sub_id);
            }
            "CLOSE" => {
                // Minimal: just ignore — subscriptions cleaned up on disconnect
            }
            _ => {
                let _ = ws_sender
                    .send(Message::Text(
                        "[\"NOTICE\",\"Unknown message type\"]".into(),
                    ))
                    .await;
            }
        }
    }
}

fn verify_and_store_event(
    event: &Value,
    db: &Arc<Mutex<rusqlite::Connection>>,
    vault_pubkey_b64: &str,
) -> Result<String, String> {
    let pubkey = event["pubkey"]
        .as_str()
        .ok_or("Missing pubkey")?
        .to_string();
    let kind = event["kind"]
        .as_i64()
        .ok_or("Missing kind")?;
    let created_at = event["created_at"]
        .as_i64()
        .ok_or("Missing created_at")?;
    let tags = event["tags"]
        .as_array()
        .ok_or("Missing tags")?;
    let content = event["content"]
        .as_str()
        .ok_or("Missing content")?;
    let event_id = event["id"]
        .as_str()
        .ok_or("Missing id")?;
    let sig = event["sig"]
        .as_str()
        .ok_or("Missing sig")?;

    if pubkey != vault_pubkey_b64 {
        return Err("Event pubkey does not match vault identity".to_string());
    }

    // Recompute id
    let serialized = serde_json::to_string(&serde_json::json!([
        0, pubkey, created_at, kind, tags, content
    ]))
    .map_err(|_| "Serialization failed".to_string())?;

    let computed_id = Sha256::digest(serialized.as_bytes());
    let computed_id_b64 = base64.encode(computed_id);

    if computed_id_b64 != event_id {
        return Err("Event id mismatch".to_string());
    }

    // Verify signature
    let sig_bytes = base64
        .decode(sig.as_bytes())
        .map_err(|_| "Invalid sig encoding".to_string())?;
    let signature =
        Signature::from_slice(&sig_bytes).map_err(|_| "Invalid sig format".to_string())?;

    let id_bytes = base64
        .decode(event_id.as_bytes())
        .map_err(|_| "Invalid id encoding".to_string())?;

    let pubkey_bytes = base64
        .decode(&pubkey.as_bytes())
        .map_err(|_| "Invalid pubkey encoding".to_string())?;
    let pubkey_arr: [u8; 32] = pubkey_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid pubkey length".to_string())?;
    let verifying_key =
        VerifyingKey::from_bytes(&pubkey_arr).map_err(|_| "Invalid pubkey".to_string())?;

    verifying_key
        .verify(&id_bytes, &signature)
        .map_err(|_| "Signature verification failed".to_string())?;

    // Store
    let db = db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            event_id,
            pubkey,
            created_at,
            kind,
            serde_json::to_string(tags).unwrap_or_default(),
            content,
            sig
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(event_id.to_string())
}

fn query_events(
    db: &Arc<Mutex<rusqlite::Connection>>,
    filters: &[Value],
) -> Vec<String> {
    let db = match db.lock() {
        Ok(d) => d,
        Err(_) => return vec![],
    };

    // Extract limit from filters
    let mut limit: i64 = 100;
    for f in filters {
        if let Some(l) = f["limit"].as_i64() {
            limit = l.min(500);
        }
    }

    // Extract kind filter
    let kinds: Vec<i64> = filters
        .iter()
        .filter_map(|f| f["kinds"].as_array())
        .flatten()
        .filter_map(|k| k.as_i64())
        .collect();

    let mut query = String::from(
        "SELECT id, pubkey, created_at, kind, tags, content, sig FROM events",
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if !kinds.is_empty() {
        let placeholders: Vec<String> = kinds.iter().map(|_| "?".to_string()).collect();
        query.push_str(&format!(" WHERE kind IN ({})", placeholders.join(",")));
        for k in &kinds {
            params.push(Box::new(*k));
        }
    }

    query.push_str(" ORDER BY created_at DESC LIMIT ?");
    params.push(Box::new(limit));

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let mut stmt = match db.prepare(&query) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let rows = match stmt.query_map(param_refs.as_slice(), |row| {
        let id: String = row.get(0)?;
        let pubkey: String = row.get(1)?;
        let created_at: i64 = row.get(2)?;
        let kind: i64 = row.get(3)?;
        let tags: String = row.get(4)?;
        let content: String = row.get(5)?;
        let sig: String = row.get(6)?;
        Ok((
            id, pubkey, created_at, kind, tags, content, sig,
        ))
    }) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    rows.filter_map(|r| {
        r.ok().map(
            |(id, pubkey, created_at, kind, tags, content, sig)| {
                let event = serde_json::json!({
                    "id": id,
                    "pubkey": pubkey,
                    "created_at": created_at,
                    "kind": kind,
                    "tags": serde_json::from_str::<Value>(&tags).unwrap_or(Value::Array(vec![])),
                    "content": content,
                    "sig": sig,
                });
                event.to_string()
            },
        )
    })
    .collect()
}

/// Derive the vault's base64-encoded public key from a VerifyingKey.
/// Exposed for use by the Tauri command layer.
pub fn derive_vault_pubkey_from_verifying(vk: &VerifyingKey) -> Result<String, String> {
    Ok(base64.encode(vk.to_bytes()))
}
