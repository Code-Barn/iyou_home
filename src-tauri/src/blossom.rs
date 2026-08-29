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

// ---------------------------------------------------------------------------
// Blossom / BUD-01 Local Blob Server (Primary Data Plane)
//
// This module implements a minimal, database-free Blossom-compatible server
// bound to 127.0.0.1:9002. It is the exclusive local personal blob storage
// tier for iyou_home — a lean Personal Data Store (PDS).
//
// Architectural invariants enforced here:
//   • No embedded Postgres or SQLite — all blobs are written directly to
//     the local filesystem under {app_local_data_dir}/blobs/{sha256_hex}.
//   • Content-addressed via SHA-256 — the upload path IS the hex digest
//     of the body; the server re-computes and validates this on PUT.
//   • No IPFS node, DHT discovery, or P2P transport layer is embedded.
//     IPFS belongs strictly at cloud boundaries (iyou_idp downloads,
//     server-side governance anchors).
//   • Private Network Access (PNA) headers are mandatory for browser
//     pre-flight compliance (Safari/Chrome require
//     Access-Control-Allow-Private-Network: true when a public HTTPS
//     portal fetches from a loopback origin).
//
// References:
//   BUD-01: https://github.com/hzrd149/blossom/blob/master/bud-01.md
// ---------------------------------------------------------------------------

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, options},
    Router,
};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::watch;
use tower_http::cors::{Any, CorsLayer};
use tower_http::set_header::SetResponseHeaderLayer;

#[derive(Clone)]
struct BlossomState {
    blobs_dir: PathBuf,
}

pub async fn start_blossom_server(blobs_dir: PathBuf, mut shutdown_rx: watch::Receiver<bool>) {
    fs::create_dir_all(&blobs_dir)
        .await
        .expect("Failed to create blobs directory");

    let state = BlossomState { blobs_dir };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::PUT,
            Method::HEAD,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    let pna_layer = SetResponseHeaderLayer::appending(
        axum::http::header::HeaderName::from_static("access-control-allow-private-network"),
        axum::http::HeaderValue::from_static("true"),
    );

    let app = Router::new()
        .route(
            "/:hash",
            get(handle_get)
                .head(handle_head)
                .put(handle_put)
                .delete(handle_delete)
                .options(handle_options),
        )
        .route(
            "/:hash/",
            get(handle_get)
                .head(handle_head)
                .put(handle_put)
                .delete(handle_delete)
                .options(handle_options),
        )
        .route("/", options(handle_options))
        .layer(DefaultBodyLimit::max(100 * 1024 * 1024))
        .layer(cors)
        .layer(pna_layer)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:9002")
        .await
        .expect("Failed to bind Blossom server on 127.0.0.1:9002");

    println!("Blossom server listening on http://127.0.0.1:9002");

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.changed().await;
            println!("Blossom server shutting down");
        })
        .await
        .expect("Blossom server failed");
}

async fn handle_options() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, PUT, HEAD, DELETE, OPTIONS",
        )
        .header(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "Content-Type, Authorization",
        )
        .header("Access-Control-Allow-Private-Network", "true")
        .body(Body::default())
        .unwrap()
}

async fn handle_get(
    Path(hash): Path<String>,
    State(state): State<BlossomState>,
) -> impl IntoResponse {
    if !is_valid_hash(&hash) {
        return (StatusCode::BAD_REQUEST, "Invalid hash format").into_response();
    }

    let file_path = state.blobs_dir.join(&hash);

    match fs::read(&file_path).await {
        Ok(data) => {
            let mime = detect_mime_type(&data);
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .body(Body::from(data))
                .unwrap()
                .into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn handle_head(
    Path(hash): Path<String>,
    State(state): State<BlossomState>,
) -> impl IntoResponse {
    if !is_valid_hash(&hash) {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let file_path = state.blobs_dir.join(&hash);

    match fs::metadata(&file_path).await {
        Ok(meta) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_LENGTH, meta.len().to_string())
            .body(Body::default())
            .unwrap()
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn handle_put(
    Path(hash): Path<String>,
    State(state): State<BlossomState>,
    req: axum::extract::Request<Body>,
) -> impl IntoResponse {
    if !is_valid_hash(&hash) {
        return (StatusCode::BAD_REQUEST, "Invalid hash format").into_response();
    }

    let max_size: usize = 100 * 1024 * 1024;

    let body_bytes = match axum::body::to_bytes(req.into_body(), max_size).await {
        Ok(b) => b.to_vec(),
        Err(e) => {
            eprintln!("Blossom body read error: {}", e);
            return (StatusCode::PAYLOAD_TOO_LARGE, "Body too large").into_response();
        }
    };

    if body_bytes.is_empty() {
        return (StatusCode::BAD_REQUEST, "Empty body").into_response();
    }

    let mut hasher = Sha256::new();
    hasher.update(&body_bytes);
    let computed = format!("{:x}", hasher.finalize());

    if computed != hash {
        return (StatusCode::UNPROCESSABLE_ENTITY, format!("Hash mismatch")).into_response();
    }

    let file_path = state.blobs_dir.join(&hash);

    match fs::write(&file_path, &body_bytes).await {
        Ok(_) => (StatusCode::CREATED, "OK").into_response(),
        Err(e) => {
            eprintln!("Blossom write error: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Write failed").into_response()
        }
    }
}

async fn handle_delete(
    Path(hash): Path<String>,
    State(state): State<BlossomState>,
) -> impl IntoResponse {
    if !is_valid_hash(&hash) || hash != hash.to_ascii_lowercase() {
        return (StatusCode::BAD_REQUEST, "Invalid hash format").into_response();
    }

    let file_path = state.blobs_dir.join(&hash);

    match fs::metadata(&file_path).await {
        Ok(meta) if meta.is_file() => match fs::remove_file(&file_path).await {
            Ok(_) => (StatusCode::OK, "Deleted").into_response(),
            Err(e) => {
                eprintln!("Blossom delete error: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, "Delete failed").into_response()
            }
        },
        Ok(_) => (StatusCode::CONFLICT, "Path is not a blob file").into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

pub fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn detect_mime_type(data: &[u8]) -> &'static str {
    if data.len() >= 4 {
        let magic: [u8; 4] = [data[0], data[1], data[2], data[3]];
        match &magic {
            b"\x89PNG" => return "image/png",
            b"GIF8" => return "image/gif",
            b"RIFF" if data.len() > 12 && &data[8..12] == b"WEBP" => return "image/webp",
            b"%PDF" => return "application/pdf",
            b"PK\x03\x04" => return "application/zip",
            _ => {}
        }
    }
    if data.len() >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
        return "image/jpeg";
    }
    if data.len() >= 2 && data[0] == b'B' && data[1] == b'M' {
        return "image/bmp";
    }
    if let Ok(s) = std::str::from_utf8(data) {
        let trimmed = s.trim_start();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            if serde_json::from_slice::<serde_json::Value>(data).is_ok() {
                return "application/json";
            }
        }
        if trimmed.starts_with('<') {
            if trimmed.starts_with("<?xml") || trimmed.starts_with("<svg") {
                return "image/svg+xml";
            }
            return "application/xml";
        }
        if s.is_ascii()
            || s.chars()
                .all(|c| c.is_ascii() || c == '\n' || c == '\r' || c == '\t')
        {
            return "text/plain; charset=utf-8";
        }
    }
    "application/octet-stream"
}

/// Mirror a single blob from a remote Blossom server into the local store.
/// Returns `true` if the blob was fetched and written (or already existed),
/// `false` if the remote was unreachable, and an error on validation failure.
pub async fn mirror_blob_from_remote(
    hash: &str,
    remote_url: &str,
    blobs_dir: &PathBuf,
) -> Result<bool, String> {
    if !is_valid_hash(hash) {
        return Err(format!("Invalid hash format: {}", hash));
    }

    let local_path = blobs_dir.join(hash);
    if local_path.exists() {
        return Ok(true);
    }

    let url = format!("{}/{}", remote_url.trim_end_matches('/'), hash);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Blossom mirror fetch failed for {}: {}", hash, e);
            return Ok(false);
        }
    };

    if !response.status().is_success() {
        eprintln!(
            "Blossom mirror returned {} for {}",
            response.status(),
            hash
        );
        return Ok(false);
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let computed = format!("{:x}", Sha256::digest(&bytes));
    if computed != hash {
        return Err(format!(
            "SHA-256 mismatch: expected {}, got {}",
            hash, computed
        ));
    }

    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create blobs directory: {}", e))?;
    }

    fs::write(&local_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write blob: {}", e))?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_hash() {
        assert!(is_valid_hash("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
        assert!(!is_valid_hash("short"));
        assert!(!is_valid_hash("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015az")); // non-hex 'z'
    }

    #[test]
    fn test_detect_mime_type() {
        assert_eq!(detect_mime_type(b"\x89PNG\r\n\x1a\n"), "image/png");
        assert_eq!(detect_mime_type(b"GIF89a"), "image/gif");
        assert_eq!(detect_mime_type(b"%PDF-1.4"), "application/pdf");
        assert_eq!(detect_mime_type(b"{\"key\":\"value\"}"), "application/json");
        assert_eq!(detect_mime_type(b"Hello world text"), "text/plain; charset=utf-8");
    }
}
