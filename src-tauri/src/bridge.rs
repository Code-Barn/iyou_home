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

use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;

use crate::WsState;

fn pipe_or_queue(app: &AppHandle, msg_json: serde_json::Value) {
    let state = app.state::<WsState>();
    let serialized = msg_json.to_string();
    let pipe = state.challenge_channel.lock().unwrap();
    if let Some(channel) = pipe.as_ref() {
        let _ = channel.send(serialized);
        println!("!!! CHALLENGE PIPED TO REACT !!!");
    } else {
        state.pending_messages.lock().unwrap().push(serialized);
        println!("!!! CHALLENGE QUEUED — React pipe not registered yet !!!");
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

async fn handle_options_preflight(mut stream: TcpStream) {
    println!("OPTIONS pre-flight received");
    let response = b"HTTP/1.1 200 OK\r\n\
        Access-Control-Allow-Origin: *\r\n\
        Access-Control-Allow-Private-Network: true\r\n\
        Access-Control-Allow-Methods: GET, PUT, POST, OPTIONS\r\n\
        Access-Control-Allow-Headers: *\r\n\
        Content-Length: 0\r\n\
        Connection: keep-alive\r\n\r\n";
    let _ = stream.write_all(response).await;
}

async fn handle_ws_connection(stream: TcpStream, app_handle: AppHandle) {
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
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
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
                }

                let profile_id = json
                    .get("profile_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let is_sign = json["action"] == "sign" || json["type"] == "sign";
                if is_sign && json["challenge"].is_string() {
                    let challenge = json["challenge"].as_str().unwrap().to_string();
                    println!("Triggering Signature for Challenge: {}", challenge);
                    println!("DEBUG: Signing with Ed25519 (OIDC/VP compliant)");

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
                        println!("Triggering Nostr Event signing");
                        println!("DEBUG: Signing Nostr event with Ed25519 (vault key — deviates from NIP-01 secp256k1 standard)");

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
                                .and_then(|v| v.profiles.first().cloned())
                                .map(|p| p.did)
                                .unwrap_or_else(|| "did:vault:unknown".to_string());
                            println!(
                                "DEBUG: No holder_did in message, defaulting to vault DID: {}",
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
                } else if json["type"] == "OMNI_SIGN_REQUEST" {
                    handle_omni_sign_request(json, &app_handle, &response_tx).await;
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

async fn handle_connection(stream: TcpStream, app_handle: AppHandle) {
    let mut peek_buf = [0u8; 1024];
    let n = match stream.peek(&mut peek_buf).await {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };

    let data = &peek_buf[..n];

    if data.starts_with(b"OPTIONS") {
        handle_options_preflight(stream).await;
    } else if is_websocket_upgrade_request(data) {
        handle_ws_connection(stream, app_handle).await;
    }
}

async fn listen_on(addrs: &str, app: AppHandle) {
    let listener = TcpListener::bind(addrs)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind WS on {}: {}", addrs, e));
    println!("WebSocket server listening on ws://{}", addrs);

    while let Ok((stream, peer)) = listener.accept().await {
        println!("TCP Connection received from: {:?}", peer);
        let app_handle = app.clone();
        tokio::spawn(async move {
            handle_connection(stream, app_handle).await;
        });
    }
}

async fn handle_omni_sign_request(
    json: serde_json::Value,
    app_handle: &AppHandle,
    response_tx: &mpsc::UnboundedSender<Message>,
) {
    let protocol = json["protocol"].as_str().unwrap_or("");
    if protocol != "POLLY_V2" {
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

    let app = app_handle.clone();
    let tx = response_tx.clone();
    tokio::spawn(async move {
        match crate::sign_omni_payload(&app, &payload_value, profile_id) {
            Ok(envelope) => {
                let response = serde_json::json!({
                    "type": "OMNI_SIGN_RESPONSE",
                    "protocol": "POLLY_V2",
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
