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
use tokio_rustls::rustls::pki_types::CertificateDer;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use iyou_home_lib::bridge::is_allowed_origin;

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

    let cert_bytes = include_bytes!("../../certs/production.crt");
    let key_bytes = include_bytes!("../../certs/production.key");

    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut &cert_bytes[..])
        .collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut &key_bytes[..])?
        .expect("production.key must contain private key");

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
