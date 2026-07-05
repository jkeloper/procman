import { Tabs, TabsList, TabsTrigger, TabsContent } from "procman"

export function ProcessTabs() {
  return (
    <div style={{ maxWidth: 480 }}>
      <Tabs defaultValue="logs">
        <TabsList>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="env">Environment</TabsTrigger>
          <TabsTrigger value="ports">Ports</TabsTrigger>
        </TabsList>
        <TabsContent value="logs">
          <div style={{ padding: "12px 4px", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted-foreground)" }}>
            vite v8 ready in 312 ms · Local: http://localhost:5173
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export function LineVariant() {
  return (
    <div style={{ maxWidth: 480 }}>
      <Tabs defaultValue="all">
        <TabsList variant="line">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="running">Running</TabsTrigger>
          <TabsTrigger value="stopped">Stopped</TabsTrigger>
        </TabsList>
        <TabsContent value="all">
          <div style={{ padding: "12px 4px", fontSize: 13, color: "var(--muted-foreground)" }}>
            15 processes across 4 projects
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
