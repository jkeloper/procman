## Summary
Brief description of changes.

## Changes
- 

## Testing
- [ ] `(cd app/src-tauri && cargo fmt -- --check && cargo test --lib && cargo clippy --all-targets -- -D warnings)` passes
- [ ] `(cd app && pnpm test && pnpm lint && pnpm build)` passes
- [ ] `(cd mobile && pnpm test && pnpm lint && pnpm build)` passes
- [ ] `swift test --package-path mobile/ios/PinnedTransportCore` passes
- [ ] `(cd mobile && pnpm exec cap sync ios)` then unsigned iOS simulator `xcodebuild` passes
- [ ] `(cd vscode-extension && pnpm typecheck && pnpm test && pnpm build)` passes
- [ ] `scripts/test-repository-checks.sh` passes
- [ ] Tested manually on macOS

## Screenshots
If UI changes, include before/after screenshots.
