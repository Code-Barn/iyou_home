use base64::{engine::general_purpose::STANDARD as base64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

const XMPP_SERVER: &str = "localhost";
const STREAM_NS: &str = "http://etherx.jabber.org/streams";
const CLIENT_NS: &str = "jabber:client";
const SASL_NS: &str = "urn:ietf:params:xml:ns:xmpp-sasl";
const BIND_NS: &str = "urn:ietf:params:xml:ns:xmpp-bind";

pub async fn start_xmpp_server(
    listener: TcpListener,
    mut shutdown_rx: watch::Receiver<bool>,
    xmpp_pass: String,
) {
    let clients: Arc<Mutex<Vec<XmppClient>>> = Arc::new(Mutex::new(Vec::new()));

    println!("XMPP server listening on :5222");

    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, peer)) => {
                        println!("XMPP connection from {:?}", peer);
                        let pass = xmpp_pass.clone();
                        let clients = clients.clone();
                        tokio::spawn(async move {
                            // Peek to detect WebSocket upgrade vs raw TCP
                            match detect_connection_type(&stream).await {
                                ConnectionType::WebSocket => {
                                    handle_xmpp_ws_connection(stream, pass, clients).await;
                                }
                                ConnectionType::RawXmpp => {
                                    handle_xmpp_connection(stream, pass, clients).await;
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

enum ConnectionType {
    WebSocket,
    RawXmpp,
}

fn is_xmpp_websocket_upgrade(data: &[u8]) -> bool {
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

async fn detect_connection_type(stream: &TcpStream) -> ConnectionType {
    let mut peek_buf = [0u8; 1024];
    let n = match stream.peek(&mut peek_buf).await {
        Ok(0) | Err(_) => return ConnectionType::RawXmpp,
        Ok(n) => n,
    };

    let data = &peek_buf[..n];

    if is_xmpp_websocket_upgrade(data) {
        ConnectionType::WebSocket
    } else {
        ConnectionType::RawXmpp
    }
}

// -- WebSocket XMPP handler --

async fn handle_xmpp_ws_connection(
    stream: TcpStream,
    password: String,
    clients: Arc<Mutex<Vec<XmppClient>>>,
) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("XMPP WS handshake failed: {}", e);
            return;
        }
    };

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let mut input = String::new();
    let mut authenticated = false;
    let mut bound_jid = String::new();

    // Send initial stream header and features over WS
    send_stream_header_ws(&mut ws_sender, false).await;
    send_sasl_features_ws(&mut ws_sender).await;

    loop {
        tokio::select! {
            msg = ws_receiver.next() => {
                let msg = match msg {
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
                input.push_str(&text);

                if !process_xmpp_buffer(&mut input, &mut authenticated, &mut bound_jid, &mut ws_sender, &password, &clients).await {
                    break;
                }
            }
        }
    }

    // Clean up client
    let mut list = clients.lock().unwrap();
    list.retain(|c| c.jid != bound_jid);
}

// -- Raw TCP XMPP handler --

async fn handle_xmpp_connection(
    mut stream: TcpStream,
    password: String,
    clients: Arc<Mutex<Vec<XmppClient>>>,
) {
    let mut buf = [0u8; 8192];
    let mut input = String::new();
    let mut authenticated = false;
    let mut bound_jid = String::new();

    // Send initial stream header
    send_stream_header(&mut stream, false).await;
    send_sasl_features(&mut stream).await;

    loop {
        let n = match stream.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        input.push_str(&String::from_utf8_lossy(&buf[..n]));

        process_xmpp_buffer_tcp(&mut input, &mut authenticated, &mut bound_jid, &mut stream, &password, &clients).await;
    }

    // Clean up client
    let mut list = clients.lock().unwrap();
    list.retain(|c| c.jid != bound_jid);
}

struct XmppClient {
    jid: String,
}

// -- Shared XMPP processing logic (WebSocket variant) --

async fn process_xmpp_buffer(
    input: &mut String,
    authenticated: &mut bool,
    bound_jid: &mut String,
    ws_sender: &mut (impl SinkExt<Message> + Unpin),
    password: &str,
    clients: &Arc<Mutex<Vec<XmppClient>>>,
) -> bool {
    loop {
        // Check for stream close
        if input.contains("</stream:stream>") || input.contains("</stream>") {
            return false;
        }

        if !*authenticated {
            if let Some(b64) = extract_sasl_auth(input) {
                if let Ok(decoded) = base64.decode(b64.as_bytes()) {
                    let decoded_str = String::from_utf8_lossy(&decoded);
                    let parts: Vec<&str> = decoded_str.split('\0').collect();
                    if parts.len() == 3 && parts[2] == password {
                        send_sasl_success_ws(ws_sender).await;
                        *authenticated = true;
                        input.clear();
                        send_stream_header_ws(ws_sender, true).await;
                        send_bind_features_ws(ws_sender).await;
                    } else {
                        send_auth_failure_ws(ws_sender).await;
                        return false;
                    }
                } else {
                    send_auth_failure_ws(ws_sender).await;
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
                    let did = "did:vault";
                    *bound_jid = format!("{}@{}/{}", did, XMPP_SERVER, resource);

                    let resp = format!(
                        "<iq type='result' id='{}'>\
                         <bind xmlns='{}'><jid>{}</jid></bind>\
                         </iq>",
                        extract_iq_id(&stanza).unwrap_or("bind1"),
                        BIND_NS,
                        *bound_jid
                    );
                    let _ = ws_sender.send(Message::Text(resp.into())).await;

                    let mut list = clients.lock().unwrap();
                    list.push(XmppClient {
                        jid: bound_jid.clone(),
                    });
                }
            } else if stanza.contains("<presence") {
                let resp = "<presence xmlns='jabber:client'/>";
                let _ = ws_sender.send(Message::Text(resp.into())).await;
            } else if stanza.contains("<message") {
                if let Some(body) = extract_message_body(&stanza) {
                    if let Some(to) = extract_message_to(&stanza) {
                        let msg = format!(
                            "<message type='chat' from='{}' to='{}'><body>{}</body></message>",
                            bound_jid, to, body
                        );
                        let _ = ws_sender.send(Message::Text(msg.into())).await;
                    }
                }
            }
        } else {
            break;
        }
    }
    true
}

// -- Shared XMPP processing logic (raw TCP variant) --

async fn process_xmpp_buffer_tcp(
    input: &mut String,
    authenticated: &mut bool,
    bound_jid: &mut String,
    stream: &mut TcpStream,
    password: &str,
    clients: &Arc<Mutex<Vec<XmppClient>>>,
) {
    loop {
        if input.contains("</stream:stream>") || input.contains("</stream>") {
            return;
        }

        if !*authenticated {
            if let Some(b64) = extract_sasl_auth(input) {
                if let Ok(decoded) = base64.decode(b64.as_bytes()) {
                    let decoded_str = String::from_utf8_lossy(&decoded);
                    let parts: Vec<&str> = decoded_str.split('\0').collect();
                    if parts.len() == 3 && parts[2] == password {
                        send_sasl_success(stream).await;
                        *authenticated = true;
                        input.clear();
                        send_stream_header(stream, true).await;
                        send_bind_features(stream).await;
                    } else {
                        send_auth_failure(stream).await;
                        return;
                    }
                } else {
                    send_auth_failure(stream).await;
                    return;
                }
                break;
            }
            break;
        }

        if let Some((stanza, rest)) = extract_xml_element(input) {
            *input = rest.to_string();

            if stanza.contains("<iq") && stanza.contains("<bind") {
                if let Some(resource) = extract_bind_resource(&stanza) {
                    let did = "did:vault";
                    *bound_jid = format!("{}@{}/{}", did, XMPP_SERVER, resource);

                    let resp = format!(
                        "<iq type='result' id='{}'>\
                         <bind xmlns='{}'><jid>{}</jid></bind>\
                         </iq>",
                        extract_iq_id(&stanza).unwrap_or("bind1"),
                        BIND_NS,
                        *bound_jid
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;

                    let mut list = clients.lock().unwrap();
                    list.push(XmppClient {
                        jid: bound_jid.clone(),
                    });
                }
            } else if stanza.contains("<presence") {
                let resp = "<presence xmlns='jabber:client'/>";
                let _ = stream.write_all(resp.as_bytes()).await;
            } else if stanza.contains("<message") {
                if let Some(body) = extract_message_body(&stanza) {
                    if let Some(to) = extract_message_to(&stanza) {
                        let msg = format!(
                            "<message type='chat' from='{}' to='{}'><body>{}</body></message>",
                            bound_jid, to, body
                        );
                        let _ = stream.write_all(msg.as_bytes()).await;
                    }
                }
            }
        } else {
            break;
        }
    }
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
    if rest.contains("/>") && !rest[..rest.find("/>")? + 2].contains(&format!("</{}", tag_name))
    {
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
                let next_tag_end = after_lt2.find(|c: char| c.is_whitespace() || c == '>' || c == '/')?;
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

// -- WS output helpers --

async fn send_stream_header_ws(ws_sender: &mut (impl SinkExt<Message> + Unpin), restart: bool) {
    let stream_id = if restart { "restart" } else { "sovereign1" };
    let msg = format!(
        "<?xml version='1.0'?>\
         <stream:stream xmlns='{}' \
         xmlns:stream='{}' \
         id='{}' from='{}' version='1.0'>",
        CLIENT_NS, STREAM_NS, stream_id, XMPP_SERVER
    );
    let _ = ws_sender.send(Message::Text(msg.into())).await;
}

async fn send_sasl_features_ws(ws_sender: &mut (impl SinkExt<Message> + Unpin)) {
    let msg = format!(
        "<stream:features>\
         <mechanisms xmlns='{}'>\
         <mechanism>PLAIN</mechanism>\
         </mechanisms>\
         </stream:features>",
        SASL_NS
    );
    let _ = ws_sender.send(Message::Text(msg.into())).await;
}

async fn send_bind_features_ws(ws_sender: &mut (impl SinkExt<Message> + Unpin)) {
    let msg = format!(
        "<stream:features>\
         <bind xmlns='{}'/>\
         </stream:features>",
        BIND_NS
    );
    let _ = ws_sender.send(Message::Text(msg.into())).await;
}

async fn send_sasl_success_ws(ws_sender: &mut (impl SinkExt<Message> + Unpin)) {
    let msg = format!("<success xmlns='{}'/>", SASL_NS);
    let _ = ws_sender.send(Message::Text(msg.into())).await;
}

async fn send_auth_failure_ws(ws_sender: &mut (impl SinkExt<Message> + Unpin)) {
    let msg = format!("<failure xmlns='{}'><not-authorized/></failure>", SASL_NS);
    let _ = ws_sender.send(Message::Text(msg.into())).await;
}

// -- Raw TCP output helpers --

async fn send_stream_header(stream: &mut TcpStream, restart: bool) {
    let stream_id = if restart { "restart" } else { "sovereign1" };
    let msg = format!(
        "<?xml version='1.0'?>\
         <stream:stream xmlns='{}' \
         xmlns:stream='{}' \
         id='{}' from='{}' version='1.0'>",
        CLIENT_NS, STREAM_NS, stream_id, XMPP_SERVER
    );
    let _ = stream.write_all(msg.as_bytes()).await;
}

async fn send_sasl_features(stream: &mut TcpStream) {
    let msg = format!(
        "<stream:features>\
         <mechanisms xmlns='{}'>\
         <mechanism>PLAIN</mechanism>\
         </mechanisms>\
         </stream:features>",
        SASL_NS
    );
    let _ = stream.write_all(msg.as_bytes()).await;
}

async fn send_bind_features(stream: &mut TcpStream) {
    let msg = format!(
        "<stream:features>\
         <bind xmlns='{}'/>\
         </stream:features>",
        BIND_NS
    );
    let _ = stream.write_all(msg.as_bytes()).await;
}

async fn send_sasl_success(stream: &mut TcpStream) {
    let msg = format!("<success xmlns='{}'/>", SASL_NS);
    let _ = stream.write_all(msg.as_bytes()).await;
}

async fn send_auth_failure(stream: &mut TcpStream) {
    let msg = format!("<failure xmlns='{}'><not-authorized/></failure>", SASL_NS);
    let _ = stream.write_all(msg.as_bytes()).await;
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
