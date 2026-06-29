import { useCallback, useEffect, useState } from 'react';
import { api, type Script, type PortInfo } from '@/api/tauri';
import { useConfirm } from '@/components/ConfirmDialog';

export interface TunnelInfo {
  url: string;
  port: number;
}

interface UseTunnelLauncherArgs {
  /** Wraps an async action in the shared busy-set tracking. */
  withBusy: (id: string, fn: () => Promise<unknown>) => Promise<void>;
  /** Per-script root PIDs, used to resolve a tunnel target port. */
  pids: Record<string, number>;
  /** Opens the multi-port picker; resolves to a chosen port via onPick. */
  openPortPicker: (picker: {
    script: Script;
    ports: PortInfo[];
    fallback?: boolean;
    rootPid?: number;
  }) => void;
  /** Re-keys tunnel restoration when the active project changes. */
  projectId?: string | null;
}

/**
 * Encapsulates Cloudflare tunnel state + launch/kill logic for scripts.
 * Extracted verbatim from ProcessGrid so the global view can reuse it.
 * Busy tracking and the multi-port picker are owned by the caller and
 * injected via `withBusy` / `openPortPicker`.
 */
export function useTunnelLauncher({
  withBusy,
  pids,
  openPortPicker,
  projectId,
}: UseTunnelLauncherArgs) {
  const confirm = useConfirm();
  const [tunnels, setTunnels] = useState<Record<string, TunnelInfo>>({});

  // Restore tunnel state from the backend on mount / project change.
  // Without this, the tunnel URL badge under each script disappears
  // when the user navigates away and comes back, even though the
  // cloudflared process is still running.
  useEffect(() => {
    let cancelled = false;
    api
      .tunnelStatus()
      .then((list) => {
        if (cancelled) return;
        const next: Record<string, TunnelInfo> = {};
        for (const t of list) {
          next[t.script_id] = { url: t.url, port: t.port };
        }
        setTunnels(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const startTunnelFor = useCallback(
    async (script: Script, port: number) => {
      await withBusy(script.id, async () => {
        try {
          const result = await api.startTunnel(port, script.id);
          if (result.url) {
            setTunnels((prev) => ({ ...prev, [script.id]: { url: result.url!, port } }));
          } else {
            await confirm({
              title: 'Tunnel started',
              description: `Tunnel running on port :${port} but no URL was returned by cloudflared.`,
              confirmLabel: 'OK',
            });
          }
        } catch (e: any) {
          await confirm({
            title: 'Tunnel failed',
            description: e?.message ?? String(e),
            confirmLabel: 'OK',
            destructive: true,
          });
        }
      });
    },
    [withBusy, confirm],
  );

  const handleTunnelClick = useCallback(
    async (script: Script) => {
      // S1: Declared ports are authoritative when present. Single declared
      // port tunnels immediately; multiple declared ports → picker.
      if (script.ports && script.ports.length > 0) {
        if (script.ports.length === 1) {
          await startTunnelFor(script, script.ports[0].number);
          return;
        }
        const declared: PortInfo[] = script.ports.map((p) => ({
          port: p.number,
          pid: pids[script.id] ?? 0,
          process_name: p.name,
          command: p.note ?? '',
        }));
        openPortPicker({ script, ports: declared });
        return;
      }

      // 2. No declared ports — look up ports owned by this script's tree.
      const rootPid = pids[script.id];
      let candidates: PortInfo[] = [];
      if (rootPid) {
        try {
          candidates = await api.listPortsForScriptPid(rootPid);
        } catch (e) {
          if (import.meta.env.DEV) console.warn('[tunnel] listPortsForScriptPid failed', e);
        }
      }
      if (import.meta.env.DEV) {
        console.log('[tunnel]', script.name, 'rootPid', rootPid, 'tree-ports', candidates);
      }

      if (candidates.length === 1) {
        await startTunnelFor(script, candidates[0].port);
        return;
      }
      if (candidates.length > 1) {
        openPortPicker({ script, ports: candidates });
        return;
      }

      // 3. Tree match returned nothing. Open the picker in fallback mode
      //    showing all listening ports — keep an info banner in the dialog
      //    so the user knows the tree match failed.
      let allPorts: PortInfo[] = [];
      try {
        allPorts = await api.listPorts();
      } catch (e) {
        if (import.meta.env.DEV) console.warn('[tunnel] listPorts failed', e);
      }
      if (allPorts.length === 0) {
        await confirm({
          title: 'No listening ports',
          description:
            'No listening TCP ports were found on this machine. Wait for ' +
            'the server to bind, or declare a port in Edit.',
          confirmLabel: 'OK',
        });
        return;
      }
      openPortPicker({ script, ports: allPorts, fallback: true, rootPid });
    },
    [startTunnelFor, pids, openPortPicker, confirm],
  );

  const killTunnel = useCallback(async (scriptId: string) => {
    try {
      await api.stopTunnel(scriptId);
      setTunnels((prev) => {
        const n = { ...prev };
        delete n[scriptId];
        return n;
      });
    } catch {}
  }, []);

  return { tunnels, setTunnels, startTunnelFor, handleTunnelClick, killTunnel };
}
