import { Label, Input, Textarea } from "procman"

export function FormFields() {
  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 340 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <Label htmlFor="name">Process name</Label>
        <Input id="name" defaultValue="api-server" />
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <Label htmlFor="cwd">Working directory</Label>
        <Input id="cwd" defaultValue="~/projects/api" />
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" placeholder="Optional notes about this process…" rows={3} />
      </div>
    </div>
  )
}
