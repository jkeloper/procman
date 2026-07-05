import { Input, Label } from "procman"

export function Variants() {
  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 320 }}>
      <Input placeholder="Filter processes…" />
      <Input defaultValue="web-dashboard" />
      <Input type="password" defaultValue="secret-token" />
      <Input placeholder="Read-only" disabled />
    </div>
  )
}

export function WithLabel() {
  return (
    <div style={{ display: "grid", gap: 6, maxWidth: 320 }}>
      <Label htmlFor="cmd">Start command</Label>
      <Input id="cmd" defaultValue="pnpm dev --host" />
    </div>
  )
}
