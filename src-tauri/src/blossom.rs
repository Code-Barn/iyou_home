use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, StatusCode, Method},
    response::{IntoResponse, Response},
    routing::{get, head, put},
    Router,
};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::fs;
use tokio::sync::watch;
use tower_http::cors::{Any, CorsLayer};

#[derive(Clone)]
struct BlossomState {
    blobs_dir: PathBuf,
}

pub async fn start_blossom_server(
    blobs_dir: PathBuf,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    fs::create_dir_all(&blobs_dir)
        .await
        .expect("Failed to create blobs directory");

    let state = BlossomState { blobs_dir };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::PUT, Method::HEAD, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    let app = Router::new()
        .route("/{hash}", get(handle_get))
        .route("/{hash}", head(handle_head))
        .route("/{hash}", put(handle_put))
        .layer(DefaultBodyLimit::max(100 * 1024 * 1024))
        .layer(cors)
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
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Hash mismatch"),
        )
            .into_response();
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

fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

fn detect_mime_type(data: &[u8]) -> &'static str {
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
