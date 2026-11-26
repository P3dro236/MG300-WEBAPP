// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://192.168.1.20:3001/" }
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App.js';

describe('@quicktone/frontend — Fail-closed LAN Pairing Check', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('renderiza shell neutro (pairing-checking-shell) sem vazar preset-grid antes de /api/pairing/status responder em origem não-localhost', async () => {
    let resolvePairing!: (res: Response) => void;
    const pairingPromise = new Promise<Response>((resolve) => {
      resolvePairing = resolve;
    });

    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/pairing/status')) {
        return pairingPromise;
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 404 }));
    }) as typeof fetch;

    render(<App />);

    expect(window.location.hostname).toBe('192.168.1.20');
    expect(screen.getByTestId('pairing-checking-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('preset-grid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stage-display')).not.toBeInTheDocument();

    resolvePairing(
      new Response(
        JSON.stringify({
          isLocalDesktop: false,
          authenticated: false,
          sessionStatus: 'none',
          activeSession: null,
          pendingRequests: [],
          activeChallenge: null,
          lanUrls: [],
        }),
        { status: 200 },
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('mobile-pairing-gate')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pairing-checking-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preset-grid')).not.toBeInTheDocument();
  });
});
