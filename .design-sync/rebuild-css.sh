#!/usr/bin/env bash
# Regenerate the /design-sync build inputs from current app source, then run
# the converter's CSS compile. Run from anywhere; resolves the repo root itself.
#
#   app/.design-sync-entry.ts  — barrel of the 12 shadcn/ui primitives (--entry)
#   app/.design-sync-tw.css    — Tailwind compile input (= src/index.css minus
#                                the @fontsource imports; fonts ship via cfg.extraFonts)
#   app/.design-sync-css.css   — compiled Tailwind stylesheet (= cfg.cssEntry)
#
# All three are gitignored (regenerable). Requires .ds-sync deps installed
# (npm i esbuild ts-morph @types/react @tailwindcss/cli in .ds-sync).
set -euo pipefail
cd "$(dirname "$0")/.."

cat > app/.design-sync-entry.ts <<'EOF'
// Generated build entry for /design-sync (claude.ai/design import).
// Re-exports the shadcn/ui primitives so the converter can bundle them into
// window.Procman. Edit the list here (and the @source glob below) to change scope.
export * from "./src/components/ui/badge";
export * from "./src/components/ui/button";
export * from "./src/components/ui/card";
export * from "./src/components/ui/command";
export * from "./src/components/ui/dialog";
export * from "./src/components/ui/input";
export * from "./src/components/ui/input-group";
export * from "./src/components/ui/label";
export * from "./src/components/ui/scroll-area";
export * from "./src/components/ui/separator";
export * from "./src/components/ui/tabs";
export * from "./src/components/ui/textarea";
EOF

{
  echo '/* Generated for /design-sync — mirrors app/src/index.css minus @fontsource'
  echo '   imports (fonts ship via cfg.extraFonts). Regenerate: .design-sync/rebuild-css.sh */'
  echo '@import "tailwindcss" source(none);'
  echo '@import "tw-animate-css";'
  echo '@import "shadcn/tailwind.css";'
  echo '@source "./src";'
  echo '@source "../.design-sync/previews";'
  # Safelist: designs built with this DS receive only styles.css's static
  # closure (no Tailwind runtime), so force-generate the common utility
  # vocabulary the design agent needs beyond what the app source happens to use.
  echo '@source inline("flex inline-flex grid block hidden flex-col flex-row flex-wrap flex-1 shrink-0");'
  echo '@source inline("items-start items-center items-end items-stretch justify-start justify-center justify-end justify-between justify-around");'
  echo '@source inline("w-full w-fit h-full min-w-0 max-w-xs max-w-sm max-w-md max-w-lg overflow-hidden overflow-auto");'
  echo '@source inline("gap-1 gap-1.5 gap-2 gap-3 gap-4 gap-6 gap-8 grid-cols-1 grid-cols-2 grid-cols-3 grid-cols-4");'
  echo '@source inline("p-0 p-1 p-2 p-3 p-4 p-6 px-2 px-3 px-4 py-1 py-1.5 py-2 py-3 m-0 mt-2 mb-2 ml-auto mr-auto");'
  echo '@source inline("text-xs text-sm text-base text-lg text-xl font-normal font-medium font-semibold font-bold font-sans font-mono text-center text-left text-right");'
  echo '@source inline("rounded rounded-sm rounded-md rounded-lg rounded-xl rounded-2xl rounded-full border border-2");'
  echo '@source inline("bg-background bg-foreground bg-card bg-popover bg-primary bg-secondary bg-muted bg-accent bg-destructive");'
  echo '@source inline("text-foreground text-card-foreground text-popover-foreground text-primary text-primary-foreground text-secondary-foreground text-muted-foreground text-accent-foreground text-destructive");'
  echo '@source inline("border-border border-input ring-ring ring-2 outline-none");'
  # Drop the app's own top import block (tailwind plugins + @fontsource) by
  # pattern, not line offset — robust to the block growing or shrinking.
  grep -v '^@import ' app/src/index.css
} > app/.design-sync-tw.css

node .ds-sync/node_modules/.bin/tailwindcss -i app/.design-sync-tw.css -o app/.design-sync-css.css
echo "rebuilt app/.design-sync-css.css ($(wc -c < app/.design-sync-css.css) bytes)"
