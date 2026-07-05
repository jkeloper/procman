import { ScrollArea } from "procman"

export function LogViewer() {
  const lines = Array.from({ length: 40 }, (_, i) => {
    const ss = String(i % 60).padStart(2, "0")
    return `[12:${ss}:14] web-dashboard  ready in ${300 + i} ms`
  })
  return (
    <ScrollArea
      style={{
        height: 220,
        width: 440,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--card)",
      }}
    >
      <div style={{ padding: 12, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.75 }}>
        {lines.map((l, i) => (
          <div key={i} style={{ color: i % 7 === 0 ? "var(--primary)" : "var(--muted-foreground)" }}>
            {l}
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
