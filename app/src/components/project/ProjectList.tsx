import { ScrollArea } from '@/components/ui/scroll-area';

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function ProjectList({ selectedId, onSelect }: Props) {
  // Placeholder data — replaced with Tauri invoke in T05
  const projects: Array<{ id: string; name: string }> = [];

  return (
    <ScrollArea className="h-full">
      <div className="p-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Projects
        </h2>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No projects yet. Create one via ⌘N.
          </p>
        ) : (
          <ul className="space-y-1">
            {projects.map((p) => (
              <li
                key={p.id}
                className={`cursor-pointer rounded px-2 py-1.5 text-sm ${
                  selectedId === p.id ? 'bg-accent' : 'hover:bg-accent/50'
                }`}
                onClick={() => onSelect(p.id)}
              >
                {p.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </ScrollArea>
  );
}
