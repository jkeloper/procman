import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';

export function LogViewer() {
  // Placeholder — will connect to PTY events in Sprint 2 (T15-T17)
  const activeTabs: Array<{ id: string; name: string; lines: string[] }> = [];

  if (activeTabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No active log streams. Start a process to see output here.
      </div>
    );
  }

  return (
    <Tabs defaultValue={activeTabs[0].id} className="flex h-full flex-col">
      <TabsList className="justify-start rounded-none border-b bg-background px-2">
        {activeTabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id} className="text-xs">
            {t.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {activeTabs.map((t) => (
        <TabsContent key={t.id} value={t.id} className="flex-1 overflow-hidden p-0">
          <ScrollArea className="h-full">
            <pre className="whitespace-pre-wrap p-3 font-mono text-xs leading-tight">
              {t.lines.join('\n')}
            </pre>
          </ScrollArea>
        </TabsContent>
      ))}
    </Tabs>
  );
}
