# /design-sync notes — procman Design System

procman is an **app**, not a component-library package. The synced design system is
the **12 shadcn/ui primitives** in `app/src/components/ui/` (Base UI + Tailwind v4 +
CVA), bundled to `window.Procman`. Project: `procman Design System`
(`81ce47af-5315-45e2-820f-2a9a7de06191`).

## How the build is wired (non-obvious)

- **No library dist.** The app's `dist/` is a website build, so there is no component
  export entry. A **synthesized barrel** `app/.design-sync-entry.ts` re-exports the 12
  ui files; `--entry ./app/.design-sync-entry.ts` makes the converter's PKG_DIR resolve
  to `app/` (walk-up to `app/package.json`) so `@/` aliases + `app/node_modules` resolve.
- **Regenerate build inputs with `.design-sync/rebuild-css.sh`** before every
  `package-build.mjs` run. It regenerates: the barrel, the Tailwind compile input
  (`app/.design-sync-tw.css`), and the compiled `app/.design-sync-css.css` (= `cfg.cssEntry`).
  All three are gitignored.
- **CSS is a controlled Tailwind v4 compile**, not a copied dist file. The input mirrors
  `app/src/index.css` **minus** the 6 `@fontsource` imports (fonts ship separately), with
  `@source "./src"` + `@source "../.design-sync/previews"` and an **`@source inline(...)`
  safelist**. The safelist matters: designs built with this DS in claude.ai/design receive
  only `styles.css`'s static closure (no Tailwind runtime), so the design agent's common
  layout/color utilities must be pre-generated — the app-scan alone misses some
  (`justify-end`, `font-sans`, `ring-ring`, `text-accent-foreground`, …).
- **Fonts** via `cfg.extraFonts`: Geist Variable + JetBrains Mono (400/500) from
  `app/node_modules/@fontsource*`. **Noto Sans KR is NOT shipped** — it's the brand's
  first font (for Korean) but its `@fontsource/noto-sans-kr` dir is empty and it's huge.
  Suppressed via `cfg.runtimeFontPrefixes: ["Noto Sans KR"]`; Latin text renders in Geist
  Variable (next in the stack). Accepted trade-off.
- **No shipped `.d.ts`** → component props are hand-written in `cfg.dtsPropsFor` (variant
  enums for Button/Badge/Tabs, composition hints for compounds).
- Run from repo root: `node .ds-sync/package-build.mjs --config .design-sync/config.json
  --node-modules app/node_modules --entry ./app/.design-sync-entry.ts --out ./ds-bundle`.

## Known render warns (benign — do not chase)

- **`[RENDER_THIN]` on `Dialog.html`** — the Base UI Dialog renders in a fixed-position
  portal, so its measured flow-height is 0px. The card actually renders the full dialog +
  blurred backdrop correctly (confirmed in `_screenshots/review/general__Dialog.png` and
  the contact sheet). `cfg.overrides.Dialog = {cardMode: single, viewport: 760x520}`.
  Benign; do not rework the preview.

## Re-sync risks / watch-list

- **`rebuild-css.sh` drops `index.css`'s import block by pattern** (`grep -v '^@import '`),
  so it's robust to the block growing/shrinking. Caveat: if `index.css` ever gains an
  `@import` **below** the top block that should ship (e.g. a new component stylesheet),
  it would be silently dropped — re-add it explicitly in the script.
- **The `@source inline` safelist is hand-maintained.** If the conventions header (or the
  design agent's needs) grows new utility classes, add them to the safelist in
  `rebuild-css.sh`, else designs using them render unstyled.
- **`cfg.componentSrcMap` + the barrel + `cfg.dtsPropsFor` all pin the 12 ui files by
  path/name.** Renaming/moving/adding a ui primitive requires updating all three (and the
  barrel list in `rebuild-css.sh`).
- **`cfg.dtsPropsFor` is hand-written** (no shipped types) and can drift from the real
  component props. Re-check on component API changes.
- **Install `typescript` in `.ds-sync` on a fresh clone** (alongside esbuild/ts-morph/
  @types/react) — it enables validate's `[DTS_PARSE]` check of the hand-written
  `dtsPropsFor` contracts. Verified clean (12/12) on 2026-07-06.
- Only the light theme + Latin/Geist rendering was visually verified. Dark mode
  (`class="dark"`) and Korean (Noto Sans KR) were not.
