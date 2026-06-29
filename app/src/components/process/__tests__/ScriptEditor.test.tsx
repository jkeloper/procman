// WS7-3: ScriptEditor progressive disclosure (Basic / Advanced).
//
// Covers:
//   1. Basic fields (name, command, declared ports) are always visible.
//   2. Advanced fields (env file, dependencies, restart policy, schedule)
//      are collapsed by default for a new script and reveal on toggle.
//   3. Editing an existing script with an advanced field configured
//      auto-expands the Advanced section so the value stays visible.
//   4. inferPortFromCommand still extracts ports from command strings
//      (declare-time autofill helper, not a runtime path).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

// ScriptEditor loads sibling scripts via api.listScripts on open and saves
// via create/update. Stub the whole api so no real Tauri calls happen.
vi.mock('@/api/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/api/tauri')>(
    '@/api/tauri',
  );
  return {
    ...actual,
    api: {
      ...actual.api,
      listScripts: vi.fn().mockResolvedValue([]),
      createScript: vi.fn().mockResolvedValue({ id: 'new' }),
      updateScript: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { ScriptEditor, inferPortFromCommand } from '../ScriptEditor';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import type { Script } from '@/api/tauri';

function mkScript(overrides: Partial<Script>): Script {
  return {
    id: 's1',
    name: 'dev',
    command: 'pnpm dev',
    ports: [],
    auto_restart: false,
    auto_restart_policy: null,
    env_file: null,
    schedule: null,
    depends_on: [],
    ...overrides,
  };
}

async function renderEditor(existing: Script | null) {
  await act(async () => {
    render(
      <ConfirmProvider>
        <ScriptEditor
          open
          onOpenChange={() => {}}
          projectId="p1"
          existing={existing}
          onSaved={() => {}}
        />
      </ConfirmProvider>,
    );
  });
}

describe('ScriptEditor progressive disclosure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Basic fields and collapses Advanced for a new script', async () => {
    await renderEditor(null);

    // Basic, always visible.
    expect(screen.getByPlaceholderText('Script name')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/pnpm dev/),
    ).toBeInTheDocument();
    expect(screen.getByText('Declared ports')).toBeInTheDocument();

    // Advanced toggle is present and collapsed.
    const toggle = screen.getByRole('button', { name: /Advanced/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Advanced fields hidden while collapsed.
    expect(screen.queryByText('.env file')).not.toBeInTheDocument();
    expect(screen.queryByText('Schedule')).not.toBeInTheDocument();
  });

  it('reveals Advanced fields on toggle', async () => {
    await renderEditor(null);
    const toggle = screen.getByRole('button', { name: /Advanced/ });

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('.env file')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(
      screen.getByText('Advanced auto-restart policy'),
    ).toBeInTheDocument();
  });

  it('auto-expands Advanced when editing a script with an env file', async () => {
    await renderEditor(mkScript({ env_file: '.env.local' }));

    const toggle = screen.getByRole('button', { name: /Advanced/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByDisplayValue('.env.local')).toBeInTheDocument();
  });

  it('keeps Advanced collapsed when editing a script with no advanced fields', async () => {
    await renderEditor(mkScript({}));

    const toggle = screen.getByRole('button', { name: /Advanced/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('inferPortFromCommand', () => {
  it('extracts ports from common flag shapes', () => {
    expect(inferPortFromCommand('pnpm dev --port 4242')).toBe(4242);
    expect(inferPortFromCommand('vite --port=5173')).toBe(5173);
    expect(inferPortFromCommand('node server -p 8080')).toBe(8080);
    expect(inferPortFromCommand('PORT=3000 npm start')).toBe(3000);
    expect(inferPortFromCommand('java -Dserver.port=9090')).toBe(9090);
  });

  it('returns null when no port is present', () => {
    expect(inferPortFromCommand('pnpm build')).toBeNull();
    expect(inferPortFromCommand('cargo test')).toBeNull();
  });
});
