import { Separator } from "procman"

export function Horizontal() {
  return (
    <div style={{ maxWidth: 300 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>Processes</div>
      <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>12 running · 3 stopped</div>
      <Separator style={{ margin: "12px 0" }} />
      <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>Last sync 2m ago</div>
    </div>
  )
}

export function Vertical() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, height: 24, fontSize: 13 }}>
      <span>CPU 3.2%</span>
      <Separator orientation="vertical" style={{ height: 16 }} />
      <span>RSS 184 MB</span>
      <Separator orientation="vertical" style={{ height: 16 }} />
      <span>PID 48213</span>
    </div>
  )
}
