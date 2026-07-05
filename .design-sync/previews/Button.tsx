import { Button } from "procman"

export function Variants() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <Button>Start all</Button>
      <Button variant="secondary">Restart</Button>
      <Button variant="outline">Logs</Button>
      <Button variant="ghost">Details</Button>
      <Button variant="destructive">Stop</Button>
      <Button variant="link">Open in editor</Button>
    </div>
  )
}

export function Sizes() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  )
}

export function States() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <Button>Enabled</Button>
      <Button disabled>Disabled</Button>
      <Button variant="outline" disabled>Waiting on port…</Button>
    </div>
  )
}
