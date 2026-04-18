# procman.kr landing site

Static Astro 5 + Tailwind v4 landing page for [procman](https://github.com/jkeloper/procman).
Deployed at **https://procman.kr**.

## Stack

- Astro 5 (static output, zero client JS by default)
- Tailwind v4 via `@tailwindcss/vite`
- TypeScript (strict)
- pnpm

## Local development

```bash
cd web
pnpm install
pnpm dev          # http://localhost:4321
pnpm build        # outputs dist/
pnpm preview      # preview dist/ locally
```

## Project layout

```
web/
├── astro.config.mjs
├── package.json
├── tsconfig.json
├── vercel.json
├── public/
│   ├── icon.png                # copied from assets/firsticon.png (2048x2048)
│   ├── robots.txt
│   └── screenshots/            # replace these SVG placeholders with real PNGs
│       ├── dashboard.svg
│       ├── logs.svg
│       ├── ports.svg
│       └── mobile.svg
└── src/
    ├── config/site.ts          # single source of truth: download URL, version, etc.
    ├── layouts/Layout.astro
    ├── components/
    │   ├── Nav.astro
    │   ├── Hero.astro
    │   ├── Features.astro
    │   ├── Screenshots.astro
    │   ├── Install.astro
    │   └── Footer.astro
    ├── pages/index.astro
    └── styles/global.css
```

## Updating the download URL / version

Every externally-facing URL lives in [`src/config/site.ts`](src/config/site.ts).
Bump the `version` and `downloadUrl` fields there when you cut a new DMG release
— the Hero, Install section, and footer all read from this one file.

## Replacing screenshots

The four `public/screenshots/*.svg` files are placeholders. Replace them with
real captures (PNG/WebP preferred) at the **same filenames** and they will be
picked up automatically.

Recommended capture flow:

1. Run procman locally, size window to ~1600x1000.
2. `cmd+shift+4` → spacebar → click window (macOS captures with rounded corners).
3. Drop the PNG into `web/public/screenshots/` using the matching name
   (e.g. `dashboard.png`), then update the `src` entries in
   `src/components/Screenshots.astro`.

> Tip: the hero icon (`public/icon.png`) is the raw 8 MB 2048×2048 source.
> For production you probably want to downscale it to ~256×256 WebP with
> e.g. `cwebp -q 85 -resize 256 0 icon.png -o icon.webp` and swap the `<link>`
> + `<img>` references in `src/layouts/Layout.astro` and `src/components/Hero.astro`.

## Deploying

### Option A — Vercel (recommended)

Astro is zero-config on Vercel.

1. Push this repo to GitHub (already done).
2. `vercel --cwd web` — or in the Vercel dashboard, "Add New → Project",
   import `jkeloper/procman`, and set **Root Directory** to `web`.
3. Framework preset auto-detects as **Astro**. No further config needed;
   `vercel.json` in this folder pins the build + install commands.

### Option B — Cloudflare Pages

1. Cloudflare Pages dashboard → "Create project" → connect GitHub repo.
2. Set:
   - **Build command**: `cd web && pnpm install && pnpm build`
   - **Build output directory**: `web/dist`
   - **Root directory (advanced)**: leave as `/`
   - **Environment variable**: `NODE_VERSION=20` (and optionally `PNPM_VERSION=9`)
3. Save and deploy.

### Option C — any static host

`pnpm build` produces a fully static `dist/` — drop it on Netlify, S3+CloudFront,
GitHub Pages (with a custom domain), or anywhere else that serves files.

## Connecting the procman.kr domain

### On Vercel

1. Project → **Settings → Domains → Add** → `procman.kr` and `www.procman.kr`.
2. Vercel shows either an A record (`76.76.21.21`) or a CNAME target.
3. In your DNS provider for `procman.kr`:
   - `@` → **A** `76.76.21.21` (Vercel default) — or follow whichever record
     Vercel tells you to add.
   - `www` → **CNAME** `cname.vercel-dns.com`.
4. Wait for DNS propagation (usually under 5 min), Vercel auto-issues
   a Let's Encrypt cert.
5. Set `procman.kr` as the production domain so Vercel redirects `www` → apex.

### On Cloudflare Pages

1. Pages project → **Custom domains → Set up a custom domain** → `procman.kr`.
2. If your DNS is already on Cloudflare, it wires up automatically. Otherwise
   add a `CNAME` from `procman.kr` to `<your-project>.pages.dev` (apex CNAME
   flattening is required — Cloudflare DNS does it natively).

## License

Same as the root project (MIT).
