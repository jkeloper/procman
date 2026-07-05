import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  Badge,
} from "procman"

export function ProcessCard() {
  return (
    <div style={{ maxWidth: 400 }}>
      <Card>
        <CardHeader>
          <CardTitle>web-dashboard</CardTitle>
          <CardDescription>Vite dev server · localhost:5173</CardDescription>
          <CardAction>
            <Badge variant="default">running</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div style={{ fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
            <div>Uptime&nbsp;&nbsp;2h 14m</div>
            <div>CPU&nbsp;&nbsp;&nbsp;&nbsp;3.2% · RSS 184 MB</div>
            <div>PID&nbsp;&nbsp;&nbsp;&nbsp;48213 (pgid 48213)</div>
          </div>
        </CardContent>
        <CardFooter>
          <div style={{ display: "flex", gap: 8, width: "100%", justifyContent: "flex-end" }}>
            <Button size="sm" variant="outline">Restart</Button>
            <Button size="sm" variant="destructive">Stop</Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}

export function StatusVariants() {
  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr", maxWidth: 560 }}>
      <Card>
        <CardHeader>
          <CardTitle>api-server</CardTitle>
          <CardDescription>cargo run · :8080</CardDescription>
          <CardAction>
            <Badge variant="default">running</Badge>
          </CardAction>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>worker</CardTitle>
          <CardDescription>node queue.js</CardDescription>
          <CardAction>
            <Badge variant="destructive">crashed</Badge>
          </CardAction>
        </CardHeader>
      </Card>
    </div>
  )
}
