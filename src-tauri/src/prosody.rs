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

/// Live client session registry: normalized bare JID -> outbound channel.
type ClientRoutes = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>>;

/// Per-connection handshake/routing state shared by the WS and raw-TCP paths.
struct ClientSession {
    /// Device identity authenticated via SASL (64-lowercase-hex public key).
    auth_hex: Option<String>,
    /// Full bound JID: `{hex}@127.0.0.1/{resource}`.
    bound_jid: String,
    /// Routing key: `{hex}@127.0.0.1`.
    bound_bare: String,
    /// Channel the writer task drains into the socket.
    own_tx: mpsc::UnboundedSender<Message>,
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

pub async fn start_xmpp_server(
    listener: TcpListener,
    mut shutdown_rx: watch::Receiver<bool>,
    xmpp_pass: String,
    cert_dir: std::path::PathBuf,
) {
    let clients: ClientRoutes = Arc::new(Mutex::new(HashMap::new()));

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
                        tokio::spawn(async move {
                            match acceptor.accept(stream).await {
                                Ok(tls_stream) => {
                                    handle_connection(tls_stream, pass, clients).await;
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

async fn handle_connection<S>(mut stream: S, password: String, clients: ClientRoutes)
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
        handle_xmpp_ws_connection(buffered, password, clients).await;
    } else {
        let buffered = ReadBuffered::new(stream, head[..n].to_vec());
        handle_xmpp_connection(buffered, password, clients).await;
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

async fn handle_xmpp_ws_connection<S>(stream: S, password: String, clients: ClientRoutes)
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

        if !process_xmpp_buffer(&mut input, &mut session, &password, &clients).await {
            break;
        }
    }

    // Clean up this session's routing entry (only if still owned by it).
    unregister_client(&clients, &session.bound_bare, &session.own_tx);
    println!(
        "DEBUG: XMPP session closed (bare={})",
        if session.bound_bare.is_empty() { "unbound" } else { &session.bound_bare }
    );
}

// -- Raw TCP XMPP handler --

async fn handle_xmpp_connection<S>(stream: S, password: String, clients: ClientRoutes)
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
        if !process_xmpp_buffer(&mut input, &mut session, &password, &clients).await {
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
}

// -- Shared XMPP processing logic (both WS and raw TCP) --

async fn process_xmpp_buffer(
    input: &mut String,
    session: &mut ClientSession,
    password: &str,
    clients: &ClientRoutes,
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
                send_ws(session, "<presence xmlns='jabber:client'/>");
            } else if stanza.contains("<message") {
                if let Some(body) = extract_message_body(&stanza) {
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

    // Skip processing instructions
    if rest.starts_with("<?") {
        let end = rest.find("?>")? + 2;
        return Some((input[start..start + end].to_string(), &input[start + end..]));
    }

    if !rest.starts_with('<') {
        return None;
    }

    let after_lt = &rest[1..];
    let tag_end = after_lt.find(|c: char| c.is_whitespace() || c == '>' || c == '/')?;
    let tag_name = &after_lt[..tag_end];

    // Self-closing: <tag ... />
    if rest.contains("/>") && !rest[..rest.find("/>")? + 2].contains(&format!("</{}", tag_name)) {
        let end = rest.find("/>")? + 2;
        return Some((input[start..start + end].to_string(), &input[start + end..]));
    }

    let mut depth = 1i32;
    let mut pos = 1;
    while depth > 0 && pos < rest.len() {
        if let Some(lt_pos) = rest[pos..].find('<') {
            let abs_pos = pos + lt_pos;
            if rest[abs_pos..].starts_with("<![CDATA[") {
                if let Some(cdata_end) = rest[abs_pos..].find("]]>") {
                    pos = abs_pos + cdata_end + 3;
                    continue;
                }
            }
            if rest[abs_pos..].starts_with("<!--") {
                if let Some(comment_end) = rest[abs_pos..].find("-->") {
                    pos = abs_pos + comment_end + 3;
                    continue;
                }
            }
            if rest[abs_pos..].starts_with("<?") {
                if let Some(pi_end) = rest[abs_pos..].find("?>") {
                    pos = abs_pos + pi_end + 2;
                    continue;
                }
            }
            if rest[abs_pos..].starts_with("/>") {
                pos = abs_pos + 2;
                continue;
            }
            if rest[abs_pos..].starts_with(&format!("</{}", tag_name))
                || rest[abs_pos..].starts_with("</stream")
            {
                depth -= 1;
                if depth == 0 {
                    let close_end = rest[abs_pos..].find('>')? + 1;
                    let end = abs_pos + close_end;
                    return Some((input[start..start + end].to_string(), &input[start + end..]));
                }
                pos = abs_pos + 1;
            } else {
                let tag_start = abs_pos + 1;
                let after_lt2 = &rest[tag_start..];
                let next_tag_end =
                    after_lt2.find(|c: char| c.is_whitespace() || c == '>' || c == '/')?;
                if after_lt2.get(..next_tag_end).map_or(false, |name| {
                    !name.starts_with('/') && !name.starts_with('?') && !name.starts_with('!')
                }) {
                    depth += 1;
                }
                pos = abs_pos + 1;
            }
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
    let id_pos = stanza.find("id='")?;
    let val_start = id_pos + 4;
    let val_end = stanza[val_start..].find('\'')?;
    Some(&stanza[val_start..val_start + val_end])
}

fn extract_message_body(stanza: &str) -> Option<String> {
    let body_start = stanza.find("<body")?;
    let body_close = stanza[body_start..].find('>')?;
    let content_start = body_start + body_close + 1;
    let content_end = stanza[content_start..].find("</body>")?;
    Some(stanza[content_start..content_start + content_end].to_string())
}

fn extract_message_to(stanza: &str) -> Option<&str> {
    for quote in ['\'', '"'] {
        let pattern = format!("to={}", quote);
        if let Some(pos) = stanza.find(&pattern) {
            let val_start = pos + pattern.len();
            if let Some(val_end) = stanza[val_start..].find(quote) {
                return Some(&stanza[val_start..val_start + val_end]);
            }
        }
    }
    None
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
}
