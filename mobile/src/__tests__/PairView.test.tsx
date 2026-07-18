import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairView } from '../PairView';
import { loadPair } from '../pair';

describe('PairView browser policy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('disables LAN, explains Tunnel-only PWA access, and pairs through fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onPaired = vi.fn();
    render(<PairView onPaired={onPaired} />);

    expect((screen.getByRole('button', { name: 'LAN' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('note').textContent).toContain('Browser/PWA access is Tunnel-only');

    fireEvent.change(screen.getByLabelText('Cloudflare Tunnel URL'), {
      target: { value: 'https://pair-ui.trycloudflare.com' },
    });
    fireEvent.change(screen.getByLabelText('Token'), {
      target: { value: 'ui-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pair-ui.trycloudflare.com/api/ping',
      expect.objectContaining({
        headers: { Authorization: 'Bearer ui-token' },
      }),
    );
    expect(loadPair()).toMatchObject({
      connectionMode: 'tunnel',
      host: 'pair-ui.trycloudflare.com',
      scheme: 'https',
    });
  });

  it('rejects insecure or non-Cloudflare manual tunnel combinations', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<PairView onPaired={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Cloudflare Tunnel URL'), {
      target: { value: 'http://pair-ui.trycloudflare.com' },
    });
    fireEvent.change(screen.getByLabelText('Token'), {
      target: { value: 'ui-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Secure HTTPS is required.')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
