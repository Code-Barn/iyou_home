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

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use iyou_home_lib::bridge::is_allowed_origin;
// SEC-002: the harness resolves TLS assets through the same runtime path as
// the application — operator-provisioned `{cert_dir}/production.{crt,key}` if
// present, otherwise an ephemeral in-memory rcgen authority. No key material
// is compiled into this binary.
use iyou_home_lib::certs::resolve_tls_assets;

/// Directory scanned for operator-provisioned certificates. Override with
/// `IYOU_TLS_CERT_DIR`; defaults to `./certs` relative to the working
/// directory.
fn cert_dir() -> std::path::PathBuf {
    match std::env::var("IYOU_TLS_CERT_DIR") {
        Ok(dir) if !dir.is_empty() => std::path::PathBuf::from(dir),
        _ => std::path::PathBuf::from("certs"),
    }
}

fn extract_header(http_request: &str, header_name: &str) -> Option<String> {
    let target = format!("{}:", header_name.to_lowercase());
    for line in http_request.lines() {
        let trimmed = line.trim();
        if trimmed.to_lowercase().starts_with(&target) {
            if let Some((_, val)) = trimmed.split_once(':') {
                return Some(val.trim().to_string());
            }
        }
    }
    None
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    println!("Starting Bridge Test Harness on wss://home.iyou.me:9001 (dual-stack [::]:9001)...");

    let cert_dir = cert_dir();
    let (certs, key) = match resolve_tls_assets(&cert_dir) {
        Ok(assets) => assets,
        Err(e) => {
            // Fail-closed: a half-provisioned or corrupt cert directory must
            // never silently downgrade to a different served identity.
            eprintln!("Bridge Test Harness TLS failure (NOT started): {}", e);
            return Err(e.into());
        }
    };

    let config = ServerConfig::builder_with_provider(Arc::new(tokio_rustls::rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(certs, key)?;

    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("[::]:9001").await?;
    println!("Bridge Test Harness listening on [::]:9001 (dual-stack)");

    while let Ok((stream, peer)) = listener.accept().await {
        println!("Accepted connection from {:?}", peer);
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            if let Ok(mut tls_stream) = acceptor.accept(stream).await {
                loop {
                    let mut buf = vec![0u8; 4096];
                    let n = match tls_stream.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    let data = &buf[..n];

                    if data.starts_with(b"OPTIONS") {
                        println!("OPTIONS pre-flight received");
                        let text = String::from_utf8_lossy(data);
                        let origin = extract_header(&text, "origin");
                        let allow_origin = match origin {
                            Some(ref o) if is_allowed_origin(o) => o.as_str(),
                            _ => "https://wun.iyou.me",
                        };

                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
Access-Control-Allow-Origin: {}\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Access-Control-Allow-Private-Network: true\r\n\
Content-Length: 0\r\n\
Connection: keep-alive\r\n\r\n",
                            allow_origin
                        );

                        let _ = tls_stream.write_all(response.as_bytes()).await;
                        let _ = tls_stream.flush().await;

                        let connection_hdr = extract_header(&text, "connection");
                        if connection_hdr
                            .as_deref()
                            .map(|c| c.eq_ignore_ascii_case("close"))
                            .unwrap_or(false)
                        {
                            return;
                        }
                    } else {
                        let text = String::from_utf8_lossy(data);
                        let origin = extract_header(&text, "origin");
                        let allow_origin = match origin {
                            Some(ref o) if is_allowed_origin(o) => o.as_str(),
                            _ => "https://wun.iyou.me",
                        };
                        let response = format!(
                            "HTTP/1.1 200 OK\r\n\
Access-Control-Allow-Origin: {}\r\n\
Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Access-Control-Allow-Private-Network: true\r\n\
Content-Type: text/plain\r\n\
Content-Length: 2\r\n\
Connection: close\r\n\r\nOK",
                            allow_origin
                        );
                        let _ = tls_stream.write_all(response.as_bytes()).await;
                        let _ = tls_stream.flush().await;
                        return;
                    }
                }
            }
        });
    }

    Ok(())
}
