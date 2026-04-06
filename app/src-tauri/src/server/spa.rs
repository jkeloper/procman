// Serve the embedded mobile PWA as a single-page app fallback.
//
// rust-embed bakes mobile/dist/* into the binary at compile time.
// GET /api/* routes are handled by axum; everything else (/, /pair,
// /index.html, assets, manifest, sw.js) falls through to this handler.

use axum::{
    body::Body,
    http::{header, Request, Response, StatusCode},
    response::IntoResponse,
};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../../mobile/dist"]
struct MobileDist;

pub async fn spa_fallback(req: Request<Body>) -> impl IntoResponse {
    let path = req.uri().path().trim_start_matches('/');
    // Try exact file match first (assets, manifest.webmanifest, sw.js, icons)
    if let Some(file) = MobileDist::get(path) {
        return serve_file(path, file.data.as_ref());
    }
    // SPA fallback: serve index.html for any non-asset route
    if let Some(file) = MobileDist::get("index.html") {
        return serve_file("index.html", file.data.as_ref());
    }
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("not found"))
        .unwrap()
}

fn serve_file(path: &str, data: &[u8]) -> Response<Body> {
    let mime = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "public, max-age=3600")
        .body(Body::from(data.to_vec()))
        .unwrap()
}
