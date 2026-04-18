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
    let cache_control = cache_control_for(path);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, cache_control)
        .body(Body::from(data.to_vec()))
        .unwrap()
}

/// Service worker and manifest must never be cached; if they are, mobile
/// PWAs get stuck on stale builds after a server upgrade. Everything else
/// (hashed assets, icons) is fine at the default 1h.
fn cache_control_for(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower == "sw.js"
        || lower.ends_with("/sw.js")
        || lower == "manifest.webmanifest"
        || lower.ends_with("/manifest.webmanifest")
        || lower == "manifest.json"
        || lower.ends_with("/manifest.json")
        || lower == "index.html"
        || lower.ends_with("/index.html")
    {
        "no-store"
    } else {
        "public, max-age=3600"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_control_no_store_for_sw_and_manifest() {
        assert_eq!(cache_control_for("sw.js"), "no-store");
        assert_eq!(cache_control_for("manifest.webmanifest"), "no-store");
        assert_eq!(cache_control_for("manifest.json"), "no-store");
        assert_eq!(cache_control_for("index.html"), "no-store");
    }

    #[test]
    fn cache_control_cacheable_for_assets() {
        assert_eq!(cache_control_for("assets/app-abcd1234.js"), "public, max-age=3600");
        assert_eq!(cache_control_for("icons/icon-192.png"), "public, max-age=3600");
    }
}
