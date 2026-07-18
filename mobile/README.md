# procman — Mobile Companion

A mobile companion for controlling desktop procman from outside, in bed, or across the house.
- **PWA** (React/TS + Capacitor) — installable straight from the browser
- **iOS native shell** (Capacitor) — for sideloading outside the App Store

For the overall project overview see the [root README](../README.md). The desktop app lives in [app/](../app/).

## Architecture
```
[Desktop LAN self-signed TLS] --native pinned REST/WS--> [Capacitor iOS]
[Desktop procman] --Cloudflare Tunnel / public HTTPS--> [Browser PWA]
```

The desktop `app/src-tauri/src/server/` module hosts the REST + WebSocket server. Capacitor iOS may connect directly on LAN only through the native transport, which pins the QR-provided SHA-256 fingerprint of the self-signed leaf certificate for both REST and WebSocket. The browser PWA does not accept direct LAN endpoints and connects through a publicly trusted HTTPS `cloudflared` tunnel.

## Prerequisites
- Node and pnpm versions pinned in `../.tool-versions`
- (iOS builds only) Xcode 15+ and an Apple Developer account

## Dev mode
```bash
cd mobile
pnpm install
pnpm dev                              # Vite PWA (port 5174)
```

## Testing
```bash
pnpm test                             # pairing, WebSocket, notifications
pnpm lint
pnpm build
swift test --package-path ios/PinnedTransportCore
pnpm exec cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

## PWA build & deploy
```bash
pnpm build                            # → dist/
# The desktop server embeds dist/ and serves it through procman's generated
# *.trycloudflare.com quick Tunnel. Arbitrary static-host origins are not
# supported by the pairing/CORS boundary.
```

## iOS build
```bash
pnpm build
pnpm exec cap sync ios
pnpm exec cap open ios                # open in Xcode, sign, build
```

The iOS project is committed under [ios/App/](ios/App/). Leave the Capacitor-generated parts (`ios/App/CapApp-SPM/`) untouched.

## Pairing flow
1. **Capacitor iOS / same LAN:** Desktop Remote Access → "Start LAN", then open procman's in-app scanner and scan its QR. Do not use Safari or the system camera for a LAN QR. Native REST and WebSocket pin the QR's leaf SHA-256 fingerprint and reject missing or mismatched certificates.
2. **Browser PWA:** Start Desktop Remote Access as "Local only" → "Expose via Cloudflare", then scan the Tunnel QR or open its public HTTPS endpoint. Direct LAN pairing is disabled.
3. The endpoint, bearer token, and (for native LAN) certificate pin are stored after pairing.
4. If the desktop LAN certificate changes, the iOS connection fails closed until the user scans a new QR and re-pairs.

## Features (full S1–S5 mirror)
- Project list (stays expanded across start/stop)
- Script start/stop/restart with live status
- Log viewer (with substring search)
- Port dashboard + liveness dot
- Mobile notifications for crashes, port conflicts, and unreachable procman
- CPU/RSS metric display
- Connect through a desktop-managed Cloudflare Tunnel
- Group execution
- ⌘K command palette (surfaced as a search button on mobile)

## Directory layout
```
mobile/
├── src/                              # React PWA source
│   ├── api.ts                        # REST + WebSocket client
│   ├── pair.ts / PairView.tsx        # QR pairing + token store
│   ├── notifications.ts              # native notification bridge
│   └── __tests__/                    # pairing/stream/alert boundaries
├── public/                           # PWA manifest + icons
├── ios/App/                          # Capacitor iOS project (Xcode workspace)
└── capacitor.config.ts
```

## Security boundary
- The tunnel endpoint is useless without the pairing token
- CORS is restricted to Capacitor, loopback development, and exact `trycloudflare.com` origins; private-IP browser origins and browser-marked LAN API requests are rejected (`app/src-tauri/src/server/routes.rs`)
- Per-IP request limits and failed-auth bans are enforced by the in-process limiter
- LAN mode is opt-in and fails closed unless its self-signed TLS certificate and pairing fingerprint are ready
- Capacitor iOS native REST and WebSocket verify the exact paired SHA-256 leaf fingerprint and never fall back to Web networking on a trust failure
- The self-signed certificate intentionally has no dynamic LAN-IP SAN; only the exact native pin match may accept it, and certificate replacement requires re-pairing
- Browser PWA direct LAN is disabled and requires a publicly trusted HTTPS Cloudflare Tunnel
- Trust boundary: do not share the tunnel endpoint with anyone you don't trust

---

# procman — 모바일 동반 앱 (한국어)

데스크톱 procman을 외출·침대·다른 방에서 조작하기 위한 모바일 동반 앱.
- **PWA** (React/TS + Capacitor) — 브라우저에서 직접 설치 가능
- **iOS 네이티브 셸** (Capacitor) — App Store 우회 설치 시 사용

전체 프로젝트 개요는 [루트 README](../README.md) 참고. 데스크톱 앱은 [app/](../app/).

## 아키텍처
```
[Desktop LAN self-signed TLS] --native pinned REST/WS--> [Capacitor iOS]
[Desktop procman] --Cloudflare Tunnel / public HTTPS--> [Browser PWA]
```

데스크톱 `app/src-tauri/src/server/` 모듈이 REST + WebSocket 서버를 띄웁니다. Capacitor iOS는 네이티브 전송 계층에서 QR의 self-signed leaf 인증서 SHA-256 fingerprint를 REST와 WebSocket 모두에 고정한 경우에만 LAN으로 직접 연결합니다. 브라우저 PWA는 direct LAN endpoint를 허용하지 않고 공개적으로 신뢰되는 HTTPS `cloudflared` 터널로 연결합니다.

## Prerequisites
- `../.tool-versions`에 고정된 Node와 pnpm
- (iOS 빌드 시) Xcode 15+ + Apple Developer 계정

## 개발 모드
```bash
cd mobile
pnpm install
pnpm dev                              # Vite PWA (port 5174)
```

## 테스트
```bash
pnpm test                             # pairing, WebSocket, notification 경계
pnpm lint
pnpm build
swift test --package-path ios/PinnedTransportCore
pnpm exec cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

## PWA 빌드 & 배포
```bash
pnpm build                            # dist/
# 데스크톱 서버가 dist/를 내장하고 생성된 *.trycloudflare.com quick Tunnel로
# 제공합니다. 임의의 정적 호스팅 origin은 pairing/CORS 경계에서 지원하지 않습니다.
```

## iOS 빌드
```bash
pnpm build
pnpm exec cap sync ios
pnpm exec cap open ios                # Xcode로 열고 서명 + 빌드
```

iOS 프로젝트는 [ios/App/](ios/App/)에 커밋되어 있음. Capacitor가 자동 생성한 부분(`ios/App/CapApp-SPM/`)은 건드리지 말 것.

## 페어링 플로우
1. **Capacitor iOS / 동일 LAN:** 데스크톱 Remote Access → "Start LAN" 후 procman 앱 내부 스캐너로 QR을 스캔합니다. LAN QR에는 Safari나 시스템 카메라를 사용하지 마세요. 네이티브 REST와 WebSocket은 QR의 leaf SHA-256 fingerprint를 고정하며, 값이 없거나 인증서가 일치하지 않으면 연결을 거부합니다.
2. **브라우저 PWA:** 데스크톱 Remote Access를 "Local only"로 시작 → "Expose via Cloudflare" 후 Tunnel QR을 스캔하거나 공개 HTTPS endpoint를 엽니다. Direct LAN 페어링은 비활성화되어 있습니다.
3. 페어링 후 endpoint, bearer token, 그리고 native LAN의 경우 certificate pin을 저장합니다.
4. 데스크톱 LAN 인증서가 바뀌면 iOS 연결은 fail-closed 처리되며, 새 QR을 스캔해 다시 페어링해야 합니다.

## 기능 (S1-S5 전부 미러링)
- 프로젝트 리스트 (펼쳐진 상태 유지 — start/stop 후에도)
- 스크립트 start/stop/restart + 실시간 상태
- 로그 뷰어 (substring 검색 포함)
- 포트 dashboard + liveness dot
- 크래시, 포트 충돌, procman 접속 불가 모바일 알림
- CPU/RSS 메트릭 표시
- 데스크톱에서 관리하는 Cloudflare Tunnel로 연결
- 그룹 실행
- ⌘K 커맨드 팔레트 (모바일에서는 검색 버튼)

## 디렉토리 구조
```
mobile/
├── src/                              # React PWA 소스
│   ├── api.ts                        # REST + WebSocket 클라이언트
│   ├── pair.ts / PairView.tsx        # QR pairing + token 저장소
│   ├── notifications.ts              # native notification bridge
│   └── __tests__/                    # pairing/stream/alert 경계 테스트
├── public/                           # PWA manifest + 아이콘
├── ios/App/                          # Capacitor iOS 프로젝트 (Xcode workspace)
└── capacitor.config.ts
```

## 보안 경계
- 터널 endpoint는 pairing token 없이는 의미있는 작업 불가
- CORS는 Capacitor, loopback 개발 환경, 정확한 `trycloudflare.com` origin으로 제한하며 private-IP 브라우저 origin과 브라우저 표식이 있는 LAN API 요청은 거부 (`app/src-tauri/src/server/routes.rs`)
- in-process limiter가 IP별 요청 제한과 인증 실패 ban을 적용
- LAN 모드는 opt-in이며 self-signed TLS 인증서와 pairing fingerprint 준비 실패 시 서버를 열지 않음
- Capacitor iOS 네이티브 REST와 WebSocket은 페어링된 SHA-256 leaf fingerprint를 정확히 검증하며, 신뢰 실패 시 Web 네트워크 계층으로 폴백하지 않음
- Self-signed 인증서에는 의도적으로 동적 LAN-IP SAN을 넣지 않으며, 정확한 native pin 일치만 이를 허용하고 인증서 교체 시 재페어링이 필요
- 브라우저 PWA의 direct LAN은 비활성화되어 있으며 공개적으로 신뢰되는 HTTPS Cloudflare Tunnel이 필수
- 신뢰 경계: 터널 endpoint를 타인에게 공유하지 말 것
