import { Badge } from "procman"

export function StatusVariants() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Badge>running</Badge>
      <Badge variant="secondary">idle</Badge>
      <Badge variant="destructive">crashed</Badge>
      <Badge variant="outline">stopped</Badge>
      <Badge variant="ghost">starting…</Badge>
      <Badge variant="link">view logs</Badge>
    </div>
  )
}

export function InlineWithText() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 500 }}>web-dashboard</span>
        <Badge>running</Badge>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 500 }}>api-server</span>
        <Badge variant="destructive">crashed</Badge>
      </div>
    </div>
  )
}
