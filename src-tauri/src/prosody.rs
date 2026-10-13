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
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, SEC_WEBSOCKET_PROTOCOL, HeaderName, HeaderValue};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

use crate::certs::{resolve_tls_assets, ReadBuffered};

const XMPP_SERVER: &str = "127.0.0.1";
const STREAM_NS: &str = "http://etherx.jabber.org/streams";
const CLIENT_NS: &str = "jabber:client";
const SASL_NS: &str = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND_NS: &str = "urn:ietf:params:xml:ns:xmpp-bind";

#[allow(dead_code)]
pub const MUC_DOMAIN_SUFFIX: &str = "@conference.127.0.0.1";

/// Live client session registry: normalized bare JID -> outbound channel.
type ClientRoutes = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>>;

#[derive(Clone, Debug)]
pub struct RoomOccupant {
    pub bare_jid: String,
    pub nickname: String,
    pub tx: mpsc::UnboundedSender<Message>,
}

#[derive(Clone, Debug)]
pub struct MucRoom {
    pub room_bare_jid: String,
    pub occupants: HashMap<String, RoomOccupant>, // keyed by bare_jid
}

pub type RoomRegistry = Arc<Mutex<HashMap<String, MucRoom>>>;

/// Per-connection handshake/routing state shared by the WS and raw-TCP paths.
pub struct ClientSession {
    /// Device identity authenticated via SASL (64-lowercase-hex public key).
    pub auth_hex: Option<String>,
    /// Full bound JID: `{hex}@127.0.0.1/{resource}`.
    pub bound_jid: String,
    /// Routing key: `{hex}@127.0.0.1`.
    pub bound_bare: String,
    /// Channel the writer task drains into the socket.
    pub own_tx: mpsc::UnboundedSender<Message>,
}

/// Normalize a recipient JID to the bare `{user}@{domain}` routing key.
pub fn normalize_bare_jid(jid: &str) -> String {
    let bare = jid.split('/').next().unwrap_or(jid);
    let mut parts = bare.rsplitn(2, '@');
    let domain = parts.next().unwrap_or("");
    let local = parts.next().unwrap_or("");
    if domain.is_empty() || local.is_empty() {
        bare.to_string()
    } else {
        format!("{}@{}", local, domain)
    }
}

pub fn extract_hex_from_did(did: &str) -> Option<String> {
    let multibase = did.strip_prefix("did:key:")?;
    if !multibase.starts_with('z') {
        return None;
    }
    let decoded = bs58::decode(&multibase[1..]).into_vec().ok()?;
    if decoded.len() != 34 || decoded[0] != 0xed || decoded[1] != 0x01 {
        return None;
    }
    Some(hex::encode(&decoded[2..]))
}

/// Extract a 64-hex identity from a PLAIN `authcid` that is either a bare hex
/// key or a bare JID whose local part is a hex key.
fn hex_from_username(user: &str) -> Option<String> {
    let local = user.split('@').next().unwrap_or(user);
    if local.len() == 64 && local.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(local.to_ascii_lowercase())
    } else {
        None
    }
}

/// Evaluate SASL PLAIN credentials (`authzid\0authcid\0password`). The enclave
/// accepts three forms:
///   1. the generated XMPP password;
///   2. identity-hex credential repeats (authcid == password == 64-hex);
///   3. authcid is a `did:key` (or bare JID whose local part is) whose
///      embedded 32-byte key hex equals the password.
///
/// Returns `(accepted, resolved_auth_hex)`.
fn sasl_credential_ok(parts: &[&str], password: &str) -> (bool, Option<String>) {
    if parts.len() != 3 {
        return (false, None);
    }
    let user = parts[1];
    let secret = parts[2];
    let secret_hex = secret.to_ascii_lowercase();

    if secret == password {
        return (
            true,
            extract_hex_from_did(user).or_else(|| hex_from_username(user)),
        );
    }
    if secret == user {
        return (true, Some(secret_hex));
    }
    if let Some(did_hex) = extract_hex_from_did(user) {
        if secret_hex == did_hex {
            return (true, Some(did_hex));
        }
    }
    if let Some(username_hex) = hex_from_username(user) {
        if secret_hex == username_hex {
            return (true, Some(username_hex));
        }
    }
    (false, None)
}

/// Queue a text frame onto a session's writer channel (best-effort).
fn send_ws(session: &ClientSession, text: &str) {
    let _ = session.own_tx.send(Message::Text(text.to_string()));
}

/// Forward a raw stanza to the target's registered channel. Returns false
/// when the target is offline (dropped gracefully).
fn route_message(clients: &ClientRoutes, target_bare: &str, stanza: &str) -> bool {
    let map = match clients.lock() {
        Ok(m) => m,
        Err(_) => return false,
    };
    match map.get(target_bare) {
        Some(tx) => tx.send(Message::Text(stanza.to_string())).is_ok(),
        None => false,
    }
}

/// Remove this session from the routing map only if it still owns the entry
/// (avoids clobbering a newer connection logged in under the same JID).
fn unregister_client(
    clients: &ClientRoutes,
    bare: &str,
    own_tx: &mpsc::UnboundedSender<Message>,
) {
    if bare.is_empty() {
        return;
    }
    if let Ok(mut map) = clients.lock() {
        if let Some(tx) = map.get(bare) {
            if tx.same_channel(own_tx) {
                map.remove(bare);
            }
        }
    }
}

/// Ensure an outgoing `<message>` stanza carries a canonical `from` address.
fn stamp_stanza_from(stanza: &str, from_jid: &str) -> String {
    if stanza.contains("from=") {
        return stanza.to_string();
    }
    if let Some(open_end) = stanza.find('>') {
        let attr = format!(" from='{}'", from_jid);
        // Self-closing tag: insert the attribute before `/>`.
        if let Some(slash) = stanza[..open_end].rfind('/') {
            if stanza[slash..].starts_with("/>") {
                return format!("{}{}{}", &stanza[..slash], attr, &stanza[slash..]);
            }
        }
        return format!("{}{}{}", &stanza[..open_end], attr, &stanza[open_end..]);
    }
    stanza.to_string()
}

/// Extract an attribute value from the opening tag of an XML element.
pub fn extract_stanza_attr<'a>(stanza: &'a str, attr: &str) -> Option<&'a str> {
    let first_gt = stanza.find('>')?;
    let header = &stanza[..first_gt];
    for quote in ['\'', '"'] {
        for pattern in [
            format!("{}={}", attr, quote),
            format!("{} = {}", attr, quote),
            format!("{} ={}", attr, quote),
            format!("{}= {}", attr, quote),
        ] {
            if let Some(pos) = header.find(pattern.as_str()) {
                let val_start = pos + pattern.len();
                if let Some(val_end) = header[val_start..].find(quote) {
                    return Some(&header[val_start..val_start + val_end]);
                }
            }
        }
    }
    None
}

pub fn extract_stanza_to(stanza: &str) -> Option<&str> {
    extract_stanza_attr(stanza, "to")
}

pub fn extract_stanza_type(stanza: &str) -> Option<&str> {
    extract_stanza_attr(stanza, "type")
}

/// Rewrite or stamp the `from` attribute on a stanza's root element.
pub fn rewrite_message_from(stanza: &str, new_from: &str) -> String {
    let first_gt = match stanza.find('>') {
        Some(pos) => pos,
        None => return stanza.to_string(),
    };
    let tag_header = &stanza[..first_gt];

    for quote in ['"', '\''] {
        for pattern in [
            format!("from={}", quote),
            format!("from = {}", quote),
            format!("from ={}", quote),
            format!("{}= {}", "from", quote),
        ] {
            if let Some(pos) = tag_header.find(&pattern) {
                let val_start = pos + pattern.len();
                if let Some(val_len) = tag_header[val_start..].find(quote) {
                    let val_end = val_start + val_len;
                    let mut out = String::with_capacity(stanza.len() + new_from.len());
                    out.push_str(&tag_header[..pos]);
                    out.push_str(&format!("from={}{}{}", quote, new_from, quote));
                    out.push_str(&tag_header[val_end + 1..]);
                    out.push_str(&stanza[first_gt..]);
                    return out;
                }
            }
        }
    }

    // No from attribute in the opening tag; stamp it before '>' or '/>'
    let attr = format!(" from='{}'", new_from);
    if let Some(slash) = tag_header.rfind('/') {
        if slash == tag_header.len() - 1 {
            return format!("{}{}{}", &tag_header[..slash], attr, &stanza[slash..]);
        }
    }
    format!("{}{}{}", tag_header, attr, &stanza[first_gt..])
}

/// Remove a disconnected session from any MUC rooms it joined.
pub fn unregister_occupant_from_rooms(
    rooms: &RoomRegistry,
    bare: &str,
    own_tx: &mpsc::UnboundedSender<Message>,
) {
    if bare.is_empty() {
        return;
    }
    if let Ok(mut map) = rooms.lock() {
        let mut empty_rooms = Vec::new();
        for (room_jid, room) in map.iter_mut() {
            if let Some(occ) = room.occupants.get(bare) {
                if occ.tx.same_channel(own_tx) {
                    let nick = occ.nickname.clone();
                    room.occupants.remove(bare);
                    let unavail = format!(
                        "<presence from=\"{}/{}\" type=\"unavailable\"/>",
                        room.room_bare_jid, nick
                    );
                    for remaining in room.occupants.values() {
                        let _ = remaining.tx.send(Message::Text(unavail.clone()));
                    }
                    if room.occupants.is_empty() {
                        empty_rooms.push(room_jid.clone());
                    }
                }
            }
        }
        for empty in empty_rooms {
            map.remove(&empty);
        }
    }
}

#[allow(dead_code)]
pub async fn start_prosody_daemon(
    listener: TcpListener,
    shutdown_rx: watch::Receiver<bool>,
    xmpp_pass: String,
    cert_dir: std::path::PathBuf,
) {
    start_xmpp_server(listener, shutdown_rx, xmpp_pass, cert_dir).await;
}

pub async fn start_xmpp_server(
    listener: TcpListener,
    mut shutdown_rx: watch::Receiver<bool>,
    xmpp_pass: String,
    cert_dir: std::path::PathBuf,
) {
    let clients: ClientRoutes = Arc::new(Mutex::new(HashMap::new()));
    let rooms: RoomRegistry = Arc::new(Mutex::new(HashMap::new()));

    // SEC-002: runtime cert resolution with ephemeral fallback (fail-closed).
    let (certs, key) = match resolve_tls_assets(&cert_dir) {
        Ok(assets) => assets,
        Err(e) => {
            eprintln!("XMPP TLS failure (fail-closed, server NOT started): {}", e);
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
            eprintln!("XMPP TLS config rejected (fail-closed): {}", e);
            return;
        }
    };
    let acceptor = TlsAcceptor::from(Arc::new(config));

    println!("XMPP server listening on wss://home.iyou.me:5222");

    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, peer)) => {
                        println!("XMPP connection from {:?}", peer);
                        let acceptor = acceptor.clone();
                        let pass = xmpp_pass.clone();
                        let clients = clients.clone();
                        let rooms = rooms.clone();
                        tokio::spawn(async move {
                            match acceptor.accept(stream).await {
                                Ok(tls_stream) => {
                                    handle_connection(tls_stream, pass, clients, rooms).await;
                                }
                                Err(e) => {
                                    eprintln!("XMPP TLS handshake failed from {:?}: {}", peer, e);
                                }
                            }
                        });
                    }
                    Err(e) => eprintln!("XMPP accept error: {}", e),
                }
            }
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    println!("XMPP server shutting down");
                    break;
                }
            }
        }
    }
}

async fn handle_connection<S>(
    mut stream: S,
    password: String,
    clients: ClientRoutes,
    rooms: RoomRegistry,
)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut head = vec![0u8; 4096];
    let n = match stream.read(&mut head).await {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };

    let data = &head[..n];
    let first_line_lines: Vec<String> = String::from_utf8_lossy(data)
        .lines()
        .take(1)
        .map(|l| l.trim().to_string())
        .collect();
    let first_line = first_line_lines.first().map(String::as_str).unwrap_or("");

    // CORS / PNA preflight for browsers on the private network.
    if first_line.starts_with("OPTIONS") {
        let resp = "HTTP/1.1 204 No Content\r\n\
            Access-Control-Allow-Origin: *\r\n\
            Access-Control-Allow-Private-Network: true\r\n\
            Access-Control-Allow-Methods: GET, OPTIONS\r\n\
            Access-Control-Allow-Headers: sec-websocket-protocol, sec-websocket-version, sec-websocket-key, content-type\r\n\
            Access-Control-Max-Age: 86400\r\n\
            Connection: close\r\n\r\n";
        let _ = stream.write_all(resp.as_bytes()).await;
        return;
    }

    if is_websocket_upgrade(data) {
        let buffered = ReadBuffered::new(stream, head[..n].to_vec());
        handle_xmpp_ws_connection(buffered, password, clients, rooms).await;
    } else {
        let buffered = ReadBuffered::new(stream, head[..n].to_vec());
        handle_xmpp_connection(buffered, password, clients, rooms).await;
    }
}

fn is_websocket_upgrade(data: &[u8]) -> bool {
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

// -- WebSocket XMPP handler --

async fn handle_xmpp_ws_connection<S>(
    stream: S,
    password: String,
    clients: ClientRoutes,
    rooms: RoomRegistry,
)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let ws_stream = match accept_hdr_async(stream, |request: &Request, mut response: Response| {
        // PNA safety-allow access for browser clients on the private network.
        response.headers_mut().insert(
            ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
        response.headers_mut().insert(
            HeaderName::from_static("access-control-allow-private-network"),
            HeaderValue::from_static("true"),
        );
        if let Some(protocol) = request.headers().get(SEC_WEBSOCKET_PROTOCOL) {
            if protocol.to_str().unwrap_or("").contains("xmpp") {
                response.headers_mut().insert(
                    SEC_WEBSOCKET_PROTOCOL,
                    HeaderValue::from_static("xmpp"),
                );
            }
        }
        Ok(response)
    }).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("XMPP WS handshake failed: {}", e);
            return;
        }
    };
    println!("DEBUG: XMPP WebSocket Upgrade Complete");

    let (ws_sender, mut ws_receiver) = ws_stream.split();

    // Writer task: drains the session channel into the socket so inbound
    // routed stanzas and outbound controls share one ordered write path.
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    tokio::spawn(async move {
        let mut ws_sender = ws_sender;
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(msg).await.is_err() {
                break;
            }
        }
    });

    let mut session = ClientSession {
        auth_hex: None,
        bound_jid: String::new(),
        bound_bare: String::new(),
        own_tx: tx.clone(),
    };
    let mut input = String::new();

    loop {
        let msg = match ws_receiver.next().await {
            Some(Ok(m)) => m,
            _ => break,
        };

        if !msg.is_text() {
            if msg.is_close() {
                break;
            }
            continue;
        }

        let text = msg.to_text().unwrap_or_default().to_string();

        // RFC 7395: client opens the XMPP stream with <open ...>
        if text.contains("<open") && text.contains("urn:ietf:params:xml:ns:xmpp-framing") {
            let open_reply = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" from="127.0.0.1" id="sovereign_enclave_stream" version="1.0" xml:lang="en"/>"#;
            let features_reply = if session.auth_hex.is_none() {
                r#"<stream:features xmlns:stream="http://etherx.jabber.org/streams"><mechanisms xmlns="urn:ietf:params:xml:ns:xmpp-sasl"><mechanism>PLAIN</mechanism></mechanisms></stream:features>"#
            } else {
                r#"<stream:features xmlns:stream="http://etherx.jabber.org/streams"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"/><session xmlns="urn:ietf:params:xml:ns:xmpp-session"/></stream:features>"#
            };

            send_ws(&session, open_reply);
            send_ws(&session, features_reply);
            println!("DEBUG: RFC 7395 WebSocket Stream Initiated Securely");
            continue;
        }

        input.push_str(&text);

        if !process_xmpp_buffer(&mut input, &mut session, &password, &clients, &rooms).await {
            break;
        }
    }

    // Clean up this session's routing entry (only if still owned by it).
    unregister_client(&clients, &session.bound_bare, &session.own_tx);
    unregister_occupant_from_rooms(&rooms, &session.bound_bare, &session.own_tx);
    println!(
        "DEBUG: XMPP session closed (bare={})",
        if session.bound_bare.is_empty() { "unbound" } else { &session.bound_bare }
    );
}

// -- Raw TCP XMPP handler --

async fn handle_xmpp_connection<S>(
    stream: S,
    password: String,
    clients: ClientRoutes,
    rooms: RoomRegistry,
)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut rd, wr) = tokio::io::split(stream);

    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    tokio::spawn(async move {
        let mut wr = wr;
        while let Some(msg) = rx.recv().await {
            if let Message::Text(text) = msg {
                if wr.write_all(text.as_bytes()).await.is_err() {
                    break;
                }
            }
        }
    });

    let mut session = ClientSession {
        auth_hex: None,
        bound_jid: String::new(),
        bound_bare: String::new(),
        own_tx: tx,
    };
    let mut buf = [0u8; 8192];
    let mut input = String::new();

    // Raw TCP clients expect the initial server-dir stream header immediately.
    send_ws(&session, &format!(
        "<?xml version='1.0'?>\
         <stream:stream xmlns='{}' \
         xmlns:stream='{}' \
         id='sovereign1' from='{}' version='1.0'>",
        CLIENT_NS, STREAM_NS, XMPP_SERVER
    ));
    send_ws(&session, &format!(
        "<stream:features>\
         <mechanisms xmlns='{}'>\
         <mechanism>PLAIN</mechanism>\
         </mechanisms>\
         </stream:features>",
        SASL_NS
    ));

    loop {
        let n = match rd.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        input.push_str(&String::from_utf8_lossy(&buf[..n]));

        let was_auth = session.auth_hex.is_some();
        if !process_xmpp_buffer(&mut input, &mut session, &password, &clients, &rooms).await {
            break;
        }

        // Raw TCP stacks expect the server to drive the post-auth stream
        // restart and advertise resource binding.
        if !was_auth && session.auth_hex.is_some() {
            send_ws(&session, &format!(
                "<?xml version='1.0'?>\
                 <stream:stream xmlns='{}' \
                 xmlns:stream='{}' \
                 id='restart' from='{}' version='1.0'>",
                CLIENT_NS, STREAM_NS, XMPP_SERVER
            ));
            send_ws(&session, &format!(
                "<stream:features><bind xmlns='{}'/></stream:features>",
                BIND_NS
            ));
        }
    }

    unregister_client(&clients, &session.bound_bare, &session.own_tx);
    unregister_occupant_from_rooms(&rooms, &session.bound_bare, &session.own_tx);
}

// -- Shared XMPP processing logic (both WS and raw TCP) --

pub async fn process_xmpp_buffer(
    input: &mut String,
    session: &mut ClientSession,
    password: &str,
    clients: &ClientRoutes,
    rooms: &RoomRegistry,
) -> bool {
    loop {
        // Check for stream close
        if input.contains("</stream:stream>") || input.contains("</stream>") {
            return false;
        }

        if session.auth_hex.is_none() {
            if let Some(b64) = extract_sasl_auth(input) {
                if let Ok(decoded) = base64.decode(b64.as_bytes()) {
                    let decoded_str = String::from_utf8_lossy(&decoded);
                    let parts: Vec<&str> = decoded_str.split('\0').collect();
                    let (ok, auth_hex) = sasl_credential_ok(&parts, password);
                    if ok {
                        send_ws(session, &format!("<success xmlns='{}'/>", SASL_NS));
                        session.auth_hex = auth_hex;
                        input.clear();
                    } else {
                        send_ws(
                            session,
                            &format!(
                                "<failure xmlns='{}'><not-authorized/></failure>",
                                SASL_NS
                            ),
                        );
                        return false;
                    }
                } else {
                    send_ws(
                        session,
                        &format!("<failure xmlns='{}'><not-authorized/></failure>", SASL_NS),
                    );
                    return false;
                }
                break;
            }
            break;
        }

        // Authenticated: look for stanzas
        if let Some((stanza, rest)) = extract_xml_element(input) {
            *input = rest.to_string();

            if stanza.contains("<iq") && stanza.contains("<bind") {
                if let Some(resource) = extract_bind_resource(&stanza) {
                    let auth_hex = session.auth_hex.clone().unwrap_or_default();
                    let local = if auth_hex.is_empty() {
                        "anonymous"
                    } else {
                        &auth_hex
                    };
                    session.bound_jid = format!("{}@{}/{}", local, XMPP_SERVER, resource);
                    session.bound_bare = normalize_bare_jid(&session.bound_jid);

                    let resp = format!(
                        "<iq type='result' id='{}'>\
                         <bind xmlns='{}'><jid>{}</jid></bind>\
                         </iq>",
                        extract_iq_id(&stanza).unwrap_or("bind1"),
                        BIND_NS,
                        session.bound_jid
                    );
                    send_ws(session, &resp);

                    if !session.bound_bare.is_empty() {
                        if let Ok(mut map) = clients.lock() {
                            map.insert(session.bound_bare.clone(), session.own_tx.clone());
                        }
                    }
                }
            } else if stanza.contains("<presence") {
                let to_dest = extract_stanza_to(&stanza).unwrap_or("").trim().to_string();
                if to_dest.contains("@conference.") || to_dest.contains(MUC_DOMAIN_SUFFIX) {
                    let (room_bare_jid, nickname) = match to_dest.split_once('/') {
                        Some((room, nick)) => (normalize_bare_jid(room), nick.trim().to_string()),
                        None => (normalize_bare_jid(&to_dest), String::new()),
                    };

                    let is_unavailable = extract_stanza_type(&stanza) == Some("unavailable")
                        || stanza.contains("type=\"unavailable\"")
                        || stanza.contains("type='unavailable'");

                    let bound_bare = if !session.bound_bare.is_empty() {
                        session.bound_bare.clone()
                    } else if let Some(auth) = &session.auth_hex {
                        format!("{}@{}", auth, XMPP_SERVER)
                    } else {
                        format!("anonymous@{}", XMPP_SERVER)
                    };

                    if is_unavailable {
                        if let Ok(mut map) = rooms.lock() {
                            if let Some(room) = map.get_mut(&room_bare_jid) {
                                let effective_nick = if !nickname.is_empty() {
                                    nickname.clone()
                                } else if let Some(occ) = room.occupants.get(&bound_bare) {
                                    occ.nickname.clone()
                                } else {
                                    bound_bare.split('@').next().unwrap_or("guest").to_string()
                                };
                                let occupant_full_to = if !nickname.is_empty() {
                                    to_dest.clone()
                                } else {
                                    format!("{}/{}", room_bare_jid, effective_nick)
                                };

                                room.occupants.remove(&bound_bare);
                                let unavail_stanza = format!(
                                    "<presence from=\"{}\" type=\"unavailable\"/>",
                                    occupant_full_to
                                );
                                for remaining in room.occupants.values() {
                                    let _ = remaining.tx.send(Message::Text(unavail_stanza.clone()));
                                }
                                if room.occupants.is_empty() {
                                    map.remove(&room_bare_jid);
                                }
                            }
                        }
                    } else {
                        let effective_nick = if !nickname.is_empty() {
                            nickname.clone()
                        } else {
                            bound_bare.split('@').next().unwrap_or("guest").to_string()
                        };
                        let occupant_full_to = if !nickname.is_empty() {
                            to_dest.clone()
                        } else {
                            format!("{}/{}", room_bare_jid, effective_nick)
                        };

                        if let Ok(mut map) = rooms.lock() {
                            let room = map.entry(room_bare_jid.clone()).or_insert_with(|| MucRoom {
                                room_bare_jid: room_bare_jid.clone(),
                                occupants: HashMap::new(),
                            });

                            let existing_occupants: Vec<String> = room
                                .occupants
                                .values()
                                .filter(|occ| occ.bare_jid != bound_bare)
                                .map(|occ| occ.nickname.clone())
                                .collect();

                            room.occupants.insert(
                                bound_bare.clone(),
                                RoomOccupant {
                                    bare_jid: bound_bare.clone(),
                                    nickname: effective_nick.clone(),
                                    tx: session.own_tx.clone(),
                                },
                            );

                            let join_stanza = format!("<presence from=\"{}\"/>", occupant_full_to);
                            for occ in room.occupants.values() {
                                let _ = occ.tx.send(Message::Text(join_stanza.clone()));
                            }

                            for existing_nick in existing_occupants {
                                let echo_stanza =
                                    format!("<presence from=\"{}/{}\"/>", room_bare_jid, existing_nick);
                                let _ = session.own_tx.send(Message::Text(echo_stanza));
                            }
                        }
                    }
                } else {
                    send_ws(session, "<presence xmlns='jabber:client'/>");
                }
            } else if stanza.contains("<message") {
                let is_groupchat =
                    stanza.contains("type=\"groupchat\"") || stanza.contains("type='groupchat'");

                if is_groupchat {
                    let to = extract_stanza_to(&stanza).unwrap_or("").trim().to_string();
                    let to_bare = normalize_bare_jid(&to);
                    let from_bare = if !session.bound_bare.is_empty() {
                        session.bound_bare.clone()
                    } else if let Some(auth) = &session.auth_hex {
                        format!("{}@{}", auth, XMPP_SERVER)
                    } else {
                        format!("anonymous@{}", XMPP_SERVER)
                    };

                    let mut sent = false;
                    let mut not_in_room = false;

                    if let Ok(map) = rooms.lock() {
                        if let Some(room) = map.get(&to_bare) {
                            if let Some(occupant) = room.occupants.get(&from_bare) {
                                let sender_nickname = &occupant.nickname;
                                let from_jid = format!("{}/{}", room.room_bare_jid, sender_nickname);
                                let rewritten = rewrite_message_from(&stanza, &from_jid);
                                for occ in room.occupants.values() {
                                    let _ = occ.tx.send(Message::Text(rewritten.clone()));
                                }
                                sent = true;
                            } else {
                                not_in_room = true;
                            }
                        }
                    }

                    if !sent {
                        if not_in_room {
                            send_ws(
                                session,
                                &format!(
                                    "<message type='error' to='{}'><error type='cancel'><not-acceptable/></error></message>",
                                    from_bare
                                ),
                            );
                        } else {
                            send_ws(
                                session,
                                &format!(
                                    "<message type='error' to='{}'><error type='cancel'><service-unavailable/></error></message>",
                                    from_bare
                                ),
                            );
                        }
                    }
                } else if let Some(body) = extract_message_body(&stanza) {
                    let to = extract_message_to(&stanza).unwrap_or("").trim().to_string();
                    let to_bare = normalize_bare_jid(&to);
                    let from_jid = session.bound_jid.clone();
                    let from_bare = session.bound_bare.clone();

                    if from_bare.is_empty() {
                        continue;
                    }

                    let mut reply = format!(
                        "<message type='chat' to='{}'><body>{}</body></message>",
                        to, body
                    );
                    reply = stamp_stanza_from(&reply, &from_jid);

                    if to_bare == from_bare || to.is_empty() {
                        send_ws(session, &reply);
                        continue;
                    }

                    if !route_message(clients, &to_bare, &reply) {
                        send_ws(
                            session,
                            &format!(
                                "<message type='error' to='{}'><error type='cancel'><service-unavailable/></error></message>",
                                from_bare
                            ),
                        );
                    }
                }
            }
        } else {
            break;
        }
    }
    true
}

// -- XML element extraction --

fn extract_xml_element(input: &str) -> Option<(String, &str)> {
    let start = input.find('<')?;
    let rest = &input[start..];

    // Skip comments and processing instructions at root
    if rest.starts_with("<?") {
        let end = rest.find("?>")? + 2;
        return Some((input[start..start + end].to_string(), &input[start + end..]));
    }
    if rest.starts_with("<!--") {
        let end = rest.find("-->")? + 3;
        return Some((input[start..start + end].to_string(), &input[start + end..]));
    }

    let first_close = rest.find('>')?;
    let tag_header = rest[..first_close].trim_end();

    if tag_header.starts_with("</") {
        return None;
    }

    // Self-closing root tag (e.g. <presence/>, <r/>)
    if tag_header.ends_with('/') {
        let end = start + first_close + 1;
        return Some((input[start..end].to_string(), &input[end..]));
    }

    let mut depth = 1usize;
    let mut pos = first_close + 1;

    while pos < rest.len() {
        if let Some(lt_offset) = rest[pos..].find('<') {
            let abs_lt = pos + lt_offset;
            let after_lt = &rest[abs_lt..];

            // Skip CDATA, comments <!-- ... --> and processing instructions <? ... ?>
            if after_lt.starts_with("<![CDATA[") {
                if let Some(cdata_end) = after_lt.find("]]>") {
                    pos = abs_lt + cdata_end + 3;
                    continue;
                }
            }
            if after_lt.starts_with("<!--") {
                if let Some(comment_end) = after_lt.find("-->") {
                    pos = abs_lt + comment_end + 3;
                    continue;
                }
            }
            if after_lt.starts_with("<?") {
                if let Some(pi_end) = after_lt.find("?>") {
                    pos = abs_lt + pi_end + 2;
                    continue;
                }
            }

            let gt_offset = after_lt.find('>')?;
            let tag_content = after_lt[1..gt_offset].trim();

            if tag_content.starts_with('/') {
                // Closing tag (e.g., </resource>, </bind>, </iq>)
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let end = start + abs_lt + gt_offset + 1;
                    return Some((input[start..end].to_string(), &input[end..]));
                }
            } else if !tag_content.ends_with('/') {
                // Normal child opening tag (e.g., <bind ...>, <resource>)
                depth += 1;
            }
            // Self-closing child tags (<.../>) do not change depth

            pos = abs_lt + gt_offset + 1;
        } else {
            break;
        }
    }

    None
}

fn extract_sasl_auth(input: &str) -> Option<&str> {
    let auth_start = input.find("<auth ")?;
    let auth_close = input[auth_start..].find('>')?;
    let after_open = auth_start + auth_close + 1;
    let content_end = input[after_open..].find("</auth>")?;
    Some(&input[after_open..after_open + content_end])
}

fn extract_bind_resource(stanza: &str) -> Option<String> {
    let resource_start = stanza.find("<resource>")?;
    let content_start = resource_start + "<resource>".len();
    let content_end = stanza[content_start..].find("</resource>")?;
    Some(stanza[content_start..content_start + content_end].to_string())
}

fn extract_iq_id(stanza: &str) -> Option<&str> {
    for quote in ['\'', '"'] {
        let pattern = format!("id={}", quote);
        if let Some(id_pos) = stanza.find(&pattern) {
            let val_start = id_pos + pattern.len();
            if let Some(val_end) = stanza[val_start..].find(quote) {
                return Some(&stanza[val_start..val_start + val_end]);
            }
        }
    }
    None
}

fn extract_message_body(stanza: &str) -> Option<String> {
    let body_start = stanza.find("<body")?;
    let body_close = stanza[body_start..].find('>')?;
    let content_start = body_start + body_close + 1;
    let content_end = stanza[content_start..].find("</body>")?;
    Some(stanza[content_start..content_start + content_end].to_string())
}

fn extract_message_to(stanza: &str) -> Option<&str> {
    extract_stanza_to(stanza)
}

pub fn generate_password() -> String {
    use rand::Rng;
    let charset: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::rngs::OsRng;
    (0..24)
        .map(|_| {
            let idx = rng.gen_range(0..charset.len());
            charset[idx] as char
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_bare_jids() {
        assert_eq!(
            normalize_bare_jid("deadbeef@127.0.0.1/abcdefg"),
            "deadbeef@127.0.0.1"
        );
        assert_eq!(
            normalize_bare_jid("deadbeef@127.0.0.1"),
            "deadbeef@127.0.0.1"
        );
        assert_eq!(
            normalize_bare_jid("joe@server.example/resource"),
            "joe@server.example"
        );
        assert_eq!(normalize_bare_jid("odd@input"), "odd@input");
    }

    #[test]
    fn extracts_multibase_hex_from_did_key() {
        let key_bytes: [u8; 32] =
            ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng)
                .verifying_key()
                .to_bytes();
        let mut payload = vec![0xedu8, 0x01];
        payload.extend_from_slice(&key_bytes);
        let multibase = format!("z{}", bs58::encode(&payload).into_string());
        let did = format!("did:key:{}", multibase);

        assert_eq!(extract_hex_from_did(&did), Some(hex::encode(key_bytes)));
        assert_eq!(extract_hex_from_did("did:key:znotavalidmultibase"), None);
        assert_eq!(extract_hex_from_did("https://example.com/keys"), None);
        assert_eq!(extract_hex_from_did("did:ethr:0x1234"), None);
    }

    #[test]
    fn stamps_from_into_open_tag_and_is_idempotent() {
        let out = stamp_stanza_from(
            "<message type='chat' to='aa@127.0.0.1'><body>hi</body></message>",
            "deadbeef@127.0.0.1/resource",
        );
        assert!(out.contains("from='deadbeef@127.0.0.1/resource'"));
        assert!(out.starts_with("<message type='chat' to='aa@127.0.0.1' from='deadbeef@127.0.0.1/resource'>"));
        assert_eq!(
            stamp_stanza_from(&out, "deadbeef@127.0.0.1/resource"),
            out
        );
        assert_eq!(stamp_stanza_from("<presence/>", "aa@127.0.0.1"), "<presence from='aa@127.0.0.1'/>");
    }

    #[test]
    fn sasl_accepts_did_key_generated_password_bare_jid_forms() {
        // Case 1: authcid is a did:key whose embedded key hex equals the secret.
        let key_bytes: [u8; 32] =
            ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng)
                .verifying_key()
                .to_bytes();
        let mut payload = vec![0xedu8, 0x01];
        payload.extend_from_slice(&key_bytes);
        let did = format!("did:key:z{}", bs58::encode(&payload).into_string());
        let hex_key = hex::encode(key_bytes);
        let parts = vec!["", did.as_str(), hex_key.as_str()];
        let (ok, auth) = sasl_credential_ok(&parts, "generated-pass");
        assert!(ok);
        assert_eq!(auth, Some(hex_key.clone()));

        // Case 2: authcid is the bare JID whose local part is the key hex.
        let parts = vec!["", "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"];
        let (ok, auth) = sasl_credential_ok(&parts, "generated-pass");
        assert!(ok);
        assert_eq!(auth, Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string()));

        // Case 2b: same key inside a full JID, mixed-case secret.
        let jid = "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF@127.0.0.1";
        let mixed = "DeAdBeEf".repeat(8);
        let (ok, _) = sasl_credential_ok(&["", jid, mixed.as_str()], "generated-pass");
        assert!(ok);

        // Case 3: the generated server password is accepted from any user.
        let (ok, _) = sasl_credential_ok(&["", "anyone@127.0.0.1", "generated-pass"], "generated-pass");
        assert!(ok);

        // Wrong secret, wrong shape, and cross-user guesses all fail.
        assert!(!sasl_credential_ok(&["", did.as_str(), "wrong"], "generated-pass").0);
        assert!(!sasl_credential_ok(&["", "joe@127.0.0.1", hex_key.as_str()], "generated-pass").0);
        assert!(!sasl_credential_ok(&["", did.as_str()], "generated-pass").0);
        assert!(!sasl_credential_ok(&[], "generated-pass").0);
    }

    #[tokio::test]
    async fn routes_stanza_to_bare_target() {
        let routes: ClientRoutes = Arc::new(Mutex::new(HashMap::new()));
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        routes
            .lock()
            .unwrap()
            .insert("deadbeef@127.0.0.1".to_string(), tx);

        assert!(route_message(
            &routes,
            "deadbeef@127.0.0.1",
            "<message type='chat'/>"
        ));
        let got = rx.recv().await.unwrap();
        assert_eq!(got.to_text().unwrap(), "<message type='chat'/>");

        assert!(!route_message(&routes, "offline@127.0.0.1", "<message/>"));
    }

    #[tokio::test]
    async fn unregister_only_removes_owned_entry() {
        let routes: ClientRoutes = Arc::new(Mutex::new(HashMap::new()));
        let (tx_a, _ra) = mpsc::unbounded_channel::<Message>();
        let (tx_b, _rb) = mpsc::unbounded_channel::<Message>();
        routes
            .lock()
            .unwrap()
            .insert("aa@127.0.0.1".to_string(), tx_a.clone());
        routes
            .lock()
            .unwrap()
            .insert("bb@127.0.0.1".to_string(), tx_b.clone());

        unregister_client(&routes, "aa@127.0.0.1", &tx_a);
        assert!(!routes.lock().unwrap().contains_key("aa@127.0.0.1"));
        assert!(routes.lock().unwrap().contains_key("bb@127.0.0.1"));

        // A stale session's tx cannot evict a newer owner.
        unregister_client(&routes, "bb@127.0.0.1", &tx_a);
        assert!(routes.lock().unwrap().contains_key("bb@127.0.0.1"));
        assert!(!routes.lock().unwrap().contains_key(""));
    }

    #[test]
    fn extracts_nested_xml_element_and_iq_id() {
        let xml = "<iq type=\"set\" id=\"bind_1\"><bind xmlns=\"urn:ietf:params:xml:ns:xmpp-bind\"><resource>web</resource></bind></iq>";
        let parsed = extract_xml_element(xml);
        assert!(parsed.is_some());
        let (stanza, rest) = parsed.unwrap();
        assert_eq!(stanza, xml);
        assert_eq!(rest, "");
        assert_eq!(extract_iq_id(xml), Some("bind_1"));

        // Single-quote id extraction
        let xml_sq = "<iq type='set' id='bind_sq'><bind><resource>web</resource></bind></iq>";
        assert_eq!(extract_iq_id(xml_sq), Some("bind_sq"));

        // Self-closing elements
        assert_eq!(
            extract_xml_element("<presence/>"),
            Some(("<presence/>".to_string(), ""))
        );

        // Nested message elements
        let msg = "<message type=\"chat\" to=\"user@127.0.0.1\"><body>hello world</body></message>";
        assert_eq!(extract_xml_element(msg), Some((msg.to_string(), "")));
    }

    #[test]
    fn test_muc_rewrite_message_from_variants() {
        // Case 1: No from attribute
        let in1 = "<message type=\"groupchat\" to=\"room@conference.127.0.0.1\"><body>hi</body></message>";
        let out1 = rewrite_message_from(in1, "room@conference.127.0.0.1/alice");
        assert!(out1.contains("from='room@conference.127.0.0.1/alice'"));
        assert!(out1.contains("<body>hi</body>"));

        // Case 2: Existing double-quoted from
        let in2 = "<message from=\"alice@127.0.0.1/res\" type=\"groupchat\" to=\"room@conference.127.0.0.1\"><body>hi</body></message>";
        let out2 = rewrite_message_from(in2, "room@conference.127.0.0.1/alice");
        assert_eq!(out2, "<message from=\"room@conference.127.0.0.1/alice\" type=\"groupchat\" to=\"room@conference.127.0.0.1\"><body>hi</body></message>");

        // Case 3: Existing single-quoted from
        let in3 = "<message type='groupchat' to='room@conference.127.0.0.1' from='alice@127.0.0.1/res'><body>hi</body></message>";
        let out3 = rewrite_message_from(in3, "room@conference.127.0.0.1/alice");
        assert_eq!(out3, "<message type='groupchat' to='room@conference.127.0.0.1' from='room@conference.127.0.0.1/alice'><body>hi</body></message>");

        // Case 4: Self-closing tag
        let in4 = "<message type=\"groupchat\" to=\"room@conference.127.0.0.1\"/>";
        let out4 = rewrite_message_from(in4, "room@conference.127.0.0.1/alice");
        assert_eq!(out4, "<message type=\"groupchat\" to=\"room@conference.127.0.0.1\" from='room@conference.127.0.0.1/alice'/>");

        // Case 5: Body contains from="something"
        let in5 = "<message type=\"groupchat\" to=\"room@conference.127.0.0.1\"><body>from=\"test\" in body</body></message>";
        let out5 = rewrite_message_from(in5, "room@conference.127.0.0.1/alice");
        assert!(out5.starts_with("<message type=\"groupchat\" to=\"room@conference.127.0.0.1\" from='room@conference.127.0.0.1/alice'>"));
        assert!(out5.contains("<body>from=\"test\" in body</body>"));
    }

    #[test]
    fn test_extract_stanza_attributes() {
        let s1 = "<presence to=\"lounge@conference.127.0.0.1/alice\"/>";
        assert_eq!(extract_stanza_to(s1), Some("lounge@conference.127.0.0.1/alice"));
        assert_eq!(extract_stanza_type(s1), None);

        let s2 = "<presence to='lounge@conference.127.0.0.1/bob' type='unavailable'/>";
        assert_eq!(extract_stanza_to(s2), Some("lounge@conference.127.0.0.1/bob"));
        assert_eq!(extract_stanza_type(s2), Some("unavailable"));

        let s3 = "<message to = \"room@conference.127.0.0.1\" type = 'groupchat'><body>hello</body></message>";
        assert_eq!(extract_stanza_to(s3), Some("room@conference.127.0.0.1"));
        assert_eq!(extract_stanza_type(s3), Some("groupchat"));
        assert_eq!(MUC_DOMAIN_SUFFIX, "@conference.127.0.0.1");
    }

    #[tokio::test]
    async fn test_muc_room_occupant_insertion_and_presence_fan_out() {
        let clients: ClientRoutes = Arc::new(Mutex::new(HashMap::new()));
        let rooms: RoomRegistry = Arc::new(Mutex::new(HashMap::new()));

        let (tx_a, mut rx_a) = mpsc::unbounded_channel::<Message>();
        let mut session_a = ClientSession {
            auth_hex: Some("aaaa".to_string()),
            bound_jid: "aaaa@127.0.0.1/web".to_string(),
            bound_bare: "aaaa@127.0.0.1".to_string(),
            own_tx: tx_a,
        };

        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<Message>();
        let mut session_b = ClientSession {
            auth_hex: Some("bbbb".to_string()),
            bound_jid: "bbbb@127.0.0.1/mobile".to_string(),
            bound_bare: "bbbb@127.0.0.1".to_string(),
            own_tx: tx_b,
        };

        // 1. Alice joins room
        let mut buf_a = "<presence to=\"general@conference.127.0.0.1/alice\"/>".to_string();
        assert!(process_xmpp_buffer(&mut buf_a, &mut session_a, "pass", &clients, &rooms).await);

        // Verify room and occupant in registry
        {
            let map = rooms.lock().unwrap();
            let room = map.get("general@conference.127.0.0.1").expect("Room should exist");
            assert_eq!(room.occupants.len(), 1);
            let occ = room.occupants.get("aaaa@127.0.0.1").expect("Alice should be occupant");
            assert_eq!(occ.nickname, "alice");
            assert_eq!(occ.bare_jid, "aaaa@127.0.0.1");
        }

        // Alice receives her own join presence
        let msg_a1 = rx_a.try_recv().expect("Alice should receive join presence");
        assert_eq!(
            msg_a1.to_text().unwrap(),
            "<presence from=\"general@conference.127.0.0.1/alice\"/>"
        );
        assert!(rx_a.try_recv().is_err()); // No other messages

        // 2. Bob joins room
        let mut buf_b = "<presence to=\"general@conference.127.0.0.1/bob\"/>".to_string();
        assert!(process_xmpp_buffer(&mut buf_b, &mut session_b, "pass", &clients, &rooms).await);

        // Verify room occupants
        {
            let map = rooms.lock().unwrap();
            let room = map.get("general@conference.127.0.0.1").unwrap();
            assert_eq!(room.occupants.len(), 2);
            assert!(room.occupants.contains_key("aaaa@127.0.0.1"));
            assert!(room.occupants.contains_key("bbbb@127.0.0.1"));
        }

        // Alice receives Bob's join presence broadcast
        let msg_a2 = rx_a.try_recv().expect("Alice should receive Bob's presence broadcast");
        assert_eq!(
            msg_a2.to_text().unwrap(),
            "<presence from=\"general@conference.127.0.0.1/bob\"/>"
        );

        // Bob receives his own join presence broadcast
        let msg_b1 = rx_b.try_recv().expect("Bob should receive his own presence broadcast");
        assert_eq!(
            msg_b1.to_text().unwrap(),
            "<presence from=\"general@conference.127.0.0.1/bob\"/>"
        );

        // Bob receives Alice's echoed existing occupant presence
        let msg_b2 = rx_b.try_recv().expect("Bob should receive Alice's echoed presence");
        assert_eq!(
            msg_b2.to_text().unwrap(),
            "<presence from=\"general@conference.127.0.0.1/alice\"/>"
        );

        // Channels should now be empty
        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_err());
    }

    #[tokio::test]
    async fn test_muc_groupchat_message_fan_out() {
        let clients: ClientRoutes = Arc::new(Mutex::new(HashMap::new()));
        let rooms: RoomRegistry = Arc::new(Mutex::new(HashMap::new()));

        let (tx_a, mut rx_a) = mpsc::unbounded_channel::<Message>();
        let mut session_a = ClientSession {
            auth_hex: Some("aaaa".to_string()),
            bound_jid: "aaaa@127.0.0.1/web".to_string(),
            bound_bare: "aaaa@127.0.0.1".to_string(),
            own_tx: tx_a,
        };

        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<Message>();
        let mut session_b = ClientSession {
            auth_hex: Some("bbbb".to_string()),
            bound_jid: "bbbb@127.0.0.1/mobile".to_string(),
            bound_bare: "bbbb@127.0.0.1".to_string(),
            own_tx: tx_b,
        };

        let (tx_c, mut rx_c) = mpsc::unbounded_channel::<Message>();
        let mut session_c = ClientSession {
            auth_hex: Some("cccc".to_string()),
            bound_jid: "cccc@127.0.0.1/desktop".to_string(),
            bound_bare: "cccc@127.0.0.1".to_string(),
            own_tx: tx_c,
        };

        // Alice and Bob join
        let mut join_a = "<presence to=\"lounge@conference.127.0.0.1/alice\"/>".to_string();
        process_xmpp_buffer(&mut join_a, &mut session_a, "pass", &clients, &rooms).await;
        let mut join_b = "<presence to=\"lounge@conference.127.0.0.1/bob\"/>".to_string();
        process_xmpp_buffer(&mut join_b, &mut session_b, "pass", &clients, &rooms).await;

        // Drain join presences
        while rx_a.try_recv().is_ok() {}
        while rx_b.try_recv().is_ok() {}

        // Alice sends groupchat message
        let mut msg_stanza = "<message type=\"groupchat\" to=\"lounge@conference.127.0.0.1\"><body>Hello everyone!</body></message>".to_string();
        process_xmpp_buffer(&mut msg_stanza, &mut session_a, "pass", &clients, &rooms).await;

        // Both Alice and Bob should receive the groupchat message with rewritten from
        let got_a = rx_a.try_recv().expect("Alice should receive reflected groupchat message");
        let got_b = rx_b.try_recv().expect("Bob should receive groupchat message");

        let text_a = got_a.to_text().unwrap();
        let text_b = got_b.to_text().unwrap();

        assert_eq!(text_a, text_b);
        assert!(text_a.contains("from='lounge@conference.127.0.0.1/alice'") || text_a.contains("from=\"lounge@conference.127.0.0.1/alice\""));
        assert!(text_a.contains("type=\"groupchat\"") || text_a.contains("type='groupchat'"));
        assert!(text_a.contains("<body>Hello everyone!</body>"));

        // Charlie (not an occupant) tries to send groupchat message to lounge
        let mut intruder_stanza = "<message type=\"groupchat\" to=\"lounge@conference.127.0.0.1\"><body>Intruder here</body></message>".to_string();
        process_xmpp_buffer(&mut intruder_stanza, &mut session_c, "pass", &clients, &rooms).await;

        // Charlie receives error stanza
        let err_c = rx_c.try_recv().expect("Charlie should receive error");
        assert!(err_c.to_text().unwrap().contains("<not-acceptable/>"));

        // Occupants receive nothing from intruder
        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_err());

        // Message to non-existent room
        let mut nonexist_stanza = "<message type=\"groupchat\" to=\"ghost@conference.127.0.0.1\"><body>Ghost room</body></message>".to_string();
        process_xmpp_buffer(&mut nonexist_stanza, &mut session_a, "pass", &clients, &rooms).await;
        let err_a = rx_a.try_recv().expect("Alice should receive service-unavailable");
        assert!(err_a.to_text().unwrap().contains("<service-unavailable/>"));
    }

    #[tokio::test]
    async fn test_muc_room_deletion_when_last_occupant_leaves() {
        let clients: ClientRoutes = Arc::new(Mutex::new(HashMap::new()));
        let rooms: RoomRegistry = Arc::new(Mutex::new(HashMap::new()));

        let (tx_a, mut rx_a) = mpsc::unbounded_channel::<Message>();
        let mut session_a = ClientSession {
            auth_hex: Some("aaaa".to_string()),
            bound_jid: "aaaa@127.0.0.1/web".to_string(),
            bound_bare: "aaaa@127.0.0.1".to_string(),
            own_tx: tx_a,
        };

        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<Message>();
        let mut session_b = ClientSession {
            auth_hex: Some("bbbb".to_string()),
            bound_jid: "bbbb@127.0.0.1/mobile".to_string(),
            bound_bare: "bbbb@127.0.0.1".to_string(),
            own_tx: tx_b,
        };

        // Alice and Bob join
        let mut join_a = "<presence to=\"ephemeral@conference.127.0.0.1/alice\"/>".to_string();
        process_xmpp_buffer(&mut join_a, &mut session_a, "pass", &clients, &rooms).await;
        let mut join_b = "<presence to=\"ephemeral@conference.127.0.0.1/bob\"/>".to_string();
        process_xmpp_buffer(&mut join_b, &mut session_b, "pass", &clients, &rooms).await;

        while rx_a.try_recv().is_ok() {}
        while rx_b.try_recv().is_ok() {}

        // Bob leaves
        let mut leave_b = "<presence to=\"ephemeral@conference.127.0.0.1/bob\" type=\"unavailable\"/>".to_string();
        process_xmpp_buffer(&mut leave_b, &mut session_b, "pass", &clients, &rooms).await;

        // Alice receives Bob's unavailable presence
        let unavail_b = rx_a.try_recv().expect("Alice should receive Bob's departure");
        assert_eq!(
            unavail_b.to_text().unwrap(),
            "<presence from=\"ephemeral@conference.127.0.0.1/bob\" type=\"unavailable\"/>"
        );

        // Room still exists with Alice
        {
            let map = rooms.lock().unwrap();
            let room = map.get("ephemeral@conference.127.0.0.1").expect("Room should still exist");
            assert_eq!(room.occupants.len(), 1);
            assert!(room.occupants.contains_key("aaaa@127.0.0.1"));
            assert!(!room.occupants.contains_key("bbbb@127.0.0.1"));
        }

        // Alice leaves (last occupant)
        let mut leave_a = "<presence to=\"ephemeral@conference.127.0.0.1/alice\" type=\"unavailable\"/>".to_string();
        process_xmpp_buffer(&mut leave_a, &mut session_a, "pass", &clients, &rooms).await;

        // Room should be completely deleted from registry
        {
            let map = rooms.lock().unwrap();
            assert!(!map.contains_key("ephemeral@conference.127.0.0.1"));
            assert!(map.is_empty());
        }
    }

    #[tokio::test]
    async fn test_muc_transient_cleanup_on_disconnect() {
        let clients: ClientRoutes = Arc::new(Mutex::new(HashMap::new()));
        let rooms: RoomRegistry = Arc::new(Mutex::new(HashMap::new()));

        let (tx_a, mut rx_a) = mpsc::unbounded_channel::<Message>();
        let mut session_a = ClientSession {
            auth_hex: Some("aaaa".to_string()),
            bound_jid: "aaaa@127.0.0.1/web".to_string(),
            bound_bare: "aaaa@127.0.0.1".to_string(),
            own_tx: tx_a,
        };

        let (tx_b, _rx_b) = mpsc::unbounded_channel::<Message>();
        let mut session_b = ClientSession {
            auth_hex: Some("bbbb".to_string()),
            bound_jid: "bbbb@127.0.0.1/mobile".to_string(),
            bound_bare: "bbbb@127.0.0.1".to_string(),
            own_tx: tx_b,
        };

        // Alice and Bob join
        let mut join_a = "<presence to=\"transient@conference.127.0.0.1/alice\"/>".to_string();
        process_xmpp_buffer(&mut join_a, &mut session_a, "pass", &clients, &rooms).await;
        let mut join_b = "<presence to=\"transient@conference.127.0.0.1/bob\"/>".to_string();
        process_xmpp_buffer(&mut join_b, &mut session_b, "pass", &clients, &rooms).await;

        while rx_a.try_recv().is_ok() {}

        // Bob disconnects without explicit presence
        unregister_occupant_from_rooms(&rooms, &session_b.bound_bare, &session_b.own_tx);

        // Alice receives unavailable presence for Bob
        let unavail = rx_a.try_recv().expect("Alice should receive Bob's disconnect presence");
        assert_eq!(
            unavail.to_text().unwrap(),
            "<presence from=\"transient@conference.127.0.0.1/bob\" type=\"unavailable\"/>"
        );

        // Alice disconnects
        unregister_occupant_from_rooms(&rooms, &session_a.bound_bare, &session_a.own_tx);

        // Room is deleted
        assert!(rooms.lock().unwrap().is_empty());
    }
}
