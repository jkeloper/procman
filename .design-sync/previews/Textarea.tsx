import { Textarea } from "procman"

export function Variants() {
  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 400 }}>
      <Textarea placeholder="Paste environment variables…" rows={3} />
      <Textarea defaultValue={"NODE_ENV=development\nPORT=5173\nLOG_LEVEL=debug"} rows={4} />
      <Textarea defaultValue="Read-only notes" disabled rows={2} />
    </div>
  )
}
