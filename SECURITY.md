# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in procman, please report it responsibly:

1. **Do NOT open a public GitHub issue**
2. Email: [create a GitHub security advisory](https://github.com/jkeloper/procman/security/advisories/new)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and aim to release a fix within 7 days.

## Security Model

procman is a **local development tool** that can optionally expose a remote control API.

### Trust Boundaries
- **Local mode**: All operations run with user privileges. Same trust model as running commands in a terminal.
- **Remote API (LAN/Tunnel)**: Protected by:
  - 256-bit bearer token (CSPRNG generated)
  - Rate limiting (60 requests/minute per IP, plus temporary bans after repeated authentication failures)
  - CORS restricted to known origins
  - X-Frame-Options: DENY
  - File permissions 0600 on sensitive files
- **Direct LAN on Capacitor iOS**: Native REST and WebSocket transports verify the exact SHA-256 fingerprint of the self-signed leaf certificate carried by the pairing QR. A missing, malformed, or mismatched pin fails closed without falling back to Web `fetch`/`WebSocket`.
- **Browser PWA**: Direct LAN endpoints are rejected. Browser installations connect only through an HTTPS Cloudflare Tunnel and retain the browser/OS trust store as their TLS boundary.
- **VS Code Webviews**: Sidebar and log views use nonce-based Content Security Policy plus DOM/text-only rendering for imported project data and log output.

### Known Limitations
- LAN mode is opt-in and requires a self-signed HTTPS certificate. Certificate or fingerprint setup failure prevents the LAN listener from opening. The certificate intentionally lacks a dynamic LAN-IP SAN; that exception is confined to the Capacitor iOS native trust challenge and is accepted only when the exact paired leaf SHA-256 fingerprint matches.
- Replacing or regenerating the LAN certificate invalidates the existing iOS pairing. The client rejects both REST and WebSocket until the user scans a new QR and explicitly trusts the new fingerprint.
- The remote API can start/stop processes registered in config — equivalent to shell access for those commands.
- WebSocket token-in-query authentication is not accepted. Use bearer auth for HTTP and `Sec-WebSocket-Protocol` for WebSocket clients.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | ✅        |
| < 0.3   | ❌        |
