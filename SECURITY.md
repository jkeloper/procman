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
  - Rate limiting (10 req/s per IP)
  - CORS restricted to known origins
  - Content Security Policy enforced
  - X-Frame-Options: DENY
  - File permissions 0600 on sensitive files

### Known Limitations
- LAN mode uses HTTP (not HTTPS). Use Cloudflare Tunnel for encrypted external access.
- The remote API can start/stop processes registered in config — equivalent to shell access for those commands.
- Self-signed TLS module is included but not yet wired to the server start flow.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
