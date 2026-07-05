## Building with procman UI

procman's design system is **shadcn/ui on Tailwind CSS v4 + Base UI**, themed as a
forest-green "liquid glass" desktop UI. All components are the real shipped code,
bundled at `window.Procman`. Import by name:

```tsx
import { Button, Card, CardHeader, CardTitle, Badge, Dialog, DialogContent } from "procman"
```

### Setup — no provider needed

Components are standalone (Base UI); there is **no** ThemeProvider or context to wrap.
Just ensure `styles.css` is loaded — it carries the design tokens (`:root`), the
compiled utilities, and the fonts. The default theme is **light**; opt into dark by
adding `class="dark"` to any ancestor element. Fonts ship with the bundle: Geist
Variable (UI text) and JetBrains Mono (code/logs); the brand also lists Noto Sans KR
first for Korean, provided by the host app at runtime.

### Styling idiom — Tailwind v4 utilities over semantic tokens

Style layout and one-off elements with Tailwind utility classes that resolve to the
theme tokens — **never hard-code hex colors**. The palette is semantic:

| Utility | Role |
|---|---|
| `bg-background` / `text-foreground` | app canvas + primary text |
| `bg-card` / `text-card-foreground` | opaque surfaces (cards, panels) |
| `bg-primary` / `text-primary-foreground` | primary action (forest green) |
| `bg-secondary` / `text-secondary-foreground` | secondary / low-emphasis |
| `bg-muted` / `text-muted-foreground` | subtle fills + secondary text |
| `bg-accent` / `text-accent-foreground` | hover/active accents |
| `text-destructive` / `bg-destructive/10` | danger (stop/crash) |
| `border-border`, `bg-input`, `ring-ring` | borders, field fills, focus ring |

Radius: `rounded-lg` / `rounded-xl` (base `--radius` = 0.5rem). Type: `font-sans`
(default) and `font-mono` for code, logs, ports, PIDs. For the signature Apple-style
translucency, use the glass utilities: `.glass`, `.glass-card` (cards/popovers/dialogs),
`.glass-thick` (sidebars), `.glass-bar` (toolbars). Every token is also a raw CSS var
(`var(--primary)`, `var(--muted-foreground)`, …) for inline styles.

### Component APIs — style via props, compose the parts

Primitives take variant props, not utility soup:
- **Button** — `variant` (default·outline·secondary·ghost·destructive·link), `size`
  (default·xs·sm·lg·icon·icon-xs·icon-sm·icon-lg).
- **Badge** — `variant` (default·secondary·destructive·outline·ghost·link).
- **Tabs** — `<TabsList variant="default|line">` with `TabsTrigger`/`TabsContent`.
- **InputGroupAddon** — `align` (inline-start·inline-end·block-start·block-end).

Compounds are assembled from their exported parts (see each component's `.prompt.md`
and `.d.ts`): `Card` → `CardHeader`/`CardTitle`/`CardDescription`/`CardAction`/
`CardContent`/`CardFooter`; `Dialog` → `DialogTrigger`/`DialogContent`/`DialogHeader`/
`DialogTitle`/`DialogDescription`/`DialogFooter`/`DialogClose`; `Command` →
`CommandInput`/`CommandList`/`CommandEmpty`/`CommandGroup`/`CommandItem`/
`CommandSeparator`/`CommandShortcut`; `InputGroup` → `InputGroupInput`/`InputGroupAddon`/
`InputGroupButton`/`InputGroupText`/`InputGroupTextarea`.

### Idiomatic example

```tsx
<Card>
  <CardHeader>
    <CardTitle>web-dashboard</CardTitle>
    <CardDescription>Vite dev server · localhost:5173</CardDescription>
    <CardAction><Badge>running</Badge></CardAction>
  </CardHeader>
  <CardContent>
    <p className="font-mono text-xs text-muted-foreground">Uptime 2h 14m · CPU 3.2%</p>
  </CardContent>
  <CardFooter>
    <div className="flex w-full justify-end gap-2">
      <Button size="sm" variant="outline">Restart</Button>
      <Button size="sm" variant="destructive">Stop</Button>
    </div>
  </CardFooter>
</Card>
```

The source of truth for styling is `styles.css` and its `@import` closure; read a
component's `.d.ts` for its props and `.prompt.md` for usage before composing it.
