import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Props {
  projectId: string | null;
}

export function ProcessGrid({ projectId }: Props) {
  // Placeholder data — replaced with Tauri invoke in T11 onwards
  const processes: Array<{
    id: string;
    name: string;
    status: 'running' | 'stopped' | 'error';
    port: number | null;
  }> = [];

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select a project to see its processes.
      </div>
    );
  }

  if (processes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No scripts registered for this project.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 lg:grid-cols-3">
      {processes.map((p) => (
        <Card key={p.id}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-sm">
              <span>{p.name}</span>
              <Badge
                variant={
                  p.status === 'running'
                    ? 'default'
                    : p.status === 'error'
                    ? 'destructive'
                    : 'secondary'
                }
              >
                {p.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {p.port != null ? `:${p.port}` : 'no port'}
              </span>
              <div className="space-x-1">
                <Button size="sm" variant="outline">Start</Button>
                <Button size="sm" variant="outline">Stop</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
