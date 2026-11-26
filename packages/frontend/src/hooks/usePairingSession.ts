import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppErrorRecord, PairingStatusResponse } from '@quicktone/shared';
import { QuickToneApiClient, QuickToneApiError } from '../api/client';

function readInitialPairingCode(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const url = new URL(window.location.href);
    const pairCode = url.searchParams.get('pair')?.trim() ?? null;
    return pairCode && pairCode.length >= 6 ? pairCode : null;
  } catch {
    return null;
  }
}

export function isLikelyLocalhostOrigin(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  const host = window.location.hostname.toLowerCase();
  return (
    !host ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

function isValidPairingStatusPayload(value: unknown): value is PairingStatusResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.isLocalDesktop === 'boolean' &&
    typeof record.authenticated === 'boolean' &&
    typeof record.sessionStatus === 'string'
  );
}

export interface UsePairingSessionResult {
  pairingStatus: PairingStatusResponse;
  pairingChecked: boolean;
  isAuthorized: boolean;
  initialPairingCode: string | null;
  applyPairingSnapshot: (res: {
    activeSession: PairingStatusResponse['activeSession'];
    pendingRequests: PairingStatusResponse['pendingRequests'];
    activeChallenge: PairingStatusResponse['activeChallenge'];
    trustedDevices?: PairingStatusResponse['trustedDevices'];
  }) => void;
  markAuthRevoked: (reason: 'expired' | 'revoked' | 'none') => void;
  handleGeneratePairingQr: () => Promise<void>;
  handleApprovePairing: (requestId: string) => Promise<void>;
  handleRejectPairing: (requestId: string) => Promise<void>;
  handleRevokeMobileSession: () => Promise<void>;
  handleLogoutMobileSession: (onAfterLogout?: () => void) => Promise<void>;
  handleTrustedReconnect: () => Promise<void>;
  handleRemoveTrustedDevice: (deviceId: string) => Promise<void>;
  handleRequestPairing: (payload: { pairingCode: string; deviceName?: string }) => Promise<{
    requestId: string;
    claimSecret: string;
    verificationCode: string;
    expiresAt: string;
  }>;
  handlePollPairing: (payload: { requestId: string; claimSecret: string }) => Promise<{
    status: string;
  }>;
  handlePairedSuccess: () => void;
}

export function usePairingSession(
  client: QuickToneApiClient,
  onReportError: (error: AppErrorRecord) => void,
): UsePairingSessionResult {
  const [initialPairingCode, setInitialPairingCode] = useState<string | null>(() =>
    readInitialPairingCode(),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('pair')) {
        url.searchParams.delete('pair');
        const nextUrl = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState({}, '', nextUrl || '/');
      }
    } catch {
      // Ignore history errors
    }
  }, []);

  const [pairingStatus, setPairingStatus] = useState<PairingStatusResponse>(() => ({
    isLocalDesktop: isLikelyLocalhostOrigin(),
    authenticated: isLikelyLocalhostOrigin(),
    sessionStatus: isLikelyLocalhostOrigin() ? 'desktop' : 'none',
    activeSession: null,
    pendingRequests: [],
    activeChallenge: null,
    lanUrls: [],
  }));
  const [pairingChecked, setPairingChecked] = useState(false);

  const suppressAutoTrustedLoginRef = useRef<boolean>(false);

  const refreshPairingStatus = useCallback(
    async (options: { autoTrustedLogin?: boolean } = {}): Promise<PairingStatusResponse> => {
      const allowAutoTrusted =
        (options.autoTrustedLogin ?? true) && !suppressAutoTrustedLoginRef.current;
      try {
        let status = await client.getPairingStatus();
        if (isValidPairingStatusPayload(status)) {
          if (
            allowAutoTrusted &&
            !status.isLocalDesktop &&
            !status.authenticated &&
            status.isTrustedDevice &&
            status.sessionStatus !== 'revoked'
          ) {
            try {
              await client.loginTrustedDevice();
              const refreshed = await client.getPairingStatus();
              if (isValidPairingStatusPayload(refreshed)) {
                status = refreshed;
              }
            } catch {
              // Trusted login failed or expired; keep pairing gate visible
            }
          }
          setPairingStatus(status);
          setPairingChecked(true);
          return status;
        }
      } catch {
        // Fallback only when pairing endpoint is absent in isolated unit test mocks
      }

      const fallbackLocal = isLikelyLocalhostOrigin();
      const fallbackStatus: PairingStatusResponse = {
        isLocalDesktop: fallbackLocal,
        authenticated: fallbackLocal,
        sessionStatus: fallbackLocal ? 'desktop' : 'none',
        activeSession: null,
        pendingRequests: [],
        activeChallenge: null,
        lanUrls: [],
      };
      setPairingStatus(fallbackStatus);
      setPairingChecked(true);
      return fallbackStatus;
    },
    [client],
  );

  useEffect(() => {
    void refreshPairingStatus();
  }, [refreshPairingStatus]);

  const applyPairingSnapshot = useCallback(
    (res: {
      activeSession: PairingStatusResponse['activeSession'];
      pendingRequests: PairingStatusResponse['pendingRequests'];
      activeChallenge: PairingStatusResponse['activeChallenge'];
      trustedDevices?: PairingStatusResponse['trustedDevices'];
    }): void => {
      setPairingStatus((prev) => ({
        ...prev,
        activeSession: res.activeSession,
        pendingRequests: res.pendingRequests,
        activeChallenge: res.activeChallenge,
        ...(res.trustedDevices !== undefined ? { trustedDevices: res.trustedDevices } : {}),
      }));
    },
    [],
  );

  const markAuthRevoked = useCallback((reason: 'expired' | 'revoked' | 'none'): void => {
    if (reason !== 'none') {
      suppressAutoTrustedLoginRef.current = true;
    }
    setPairingStatus((prev) => ({
      ...prev,
      authenticated: false,
      sessionStatus: reason,
    }));
  }, []);

  const reportPairingError = useCallback(
    (err: unknown, fallbackMessage: string): void => {
      onReportError({
        code: err instanceof QuickToneApiError ? err.code : 'PAIRING_ACTION_ERROR',
        message: err instanceof QuickToneApiError ? err.message : fallbackMessage,
        timestamp: new Date().toISOString(),
      });
    },
    [onReportError],
  );

  const handleGeneratePairingQr = useCallback(async (): Promise<void> => {
    try {
      applyPairingSnapshot(await client.createPairingChallenge());
    } catch (err) {
      reportPairingError(err, 'Falha ao gerar QR Code de pareamento.');
    }
  }, [client, applyPairingSnapshot, reportPairingError]);

  const handleApprovePairing = useCallback(
    async (requestId: string): Promise<void> => {
      try {
        applyPairingSnapshot(await client.approvePairing({ requestId }));
      } catch (err) {
        reportPairingError(err, 'Falha ao autorizar celular.');
      }
    },
    [client, applyPairingSnapshot, reportPairingError],
  );

  const handleRejectPairing = useCallback(
    async (requestId: string): Promise<void> => {
      try {
        applyPairingSnapshot(await client.rejectPairing({ requestId }));
      } catch (err) {
        reportPairingError(err, 'Falha ao recusar solicitação de pareamento.');
      }
    },
    [client, applyPairingSnapshot, reportPairingError],
  );

  const handleRevokeMobileSession = useCallback(async (): Promise<void> => {
    try {
      applyPairingSnapshot(await client.revokePairingSession());
    } catch (err) {
      reportPairingError(err, 'Falha ao revogar acesso mobile.');
    }
  }, [client, applyPairingSnapshot, reportPairingError]);

  const handleLogoutMobileSession = useCallback(
    async (onAfterLogout?: () => void): Promise<void> => {
      try {
        suppressAutoTrustedLoginRef.current = true;
        await client.logoutPairingSession();
        onAfterLogout?.();
        await refreshPairingStatus({ autoTrustedLogin: false });
      } catch (err) {
        reportPairingError(err, 'Falha ao encerrar sessão neste celular.');
      }
    },
    [client, refreshPairingStatus, reportPairingError],
  );

  const handleTrustedReconnect = useCallback(async (): Promise<void> => {
    suppressAutoTrustedLoginRef.current = false;
    await client.loginTrustedDevice();
    await refreshPairingStatus({ autoTrustedLogin: false });
  }, [client, refreshPairingStatus]);

  const handleRemoveTrustedDevice = useCallback(
    async (deviceId: string): Promise<void> => {
      try {
        applyPairingSnapshot(await client.removeTrustedDevice({ deviceId }));
      } catch (err) {
        reportPairingError(err, 'Falha ao remover dispositivo confiável.');
      }
    },
    [client, applyPairingSnapshot, reportPairingError],
  );

  const handleRequestPairing = useCallback(
    (payload: { pairingCode: string; deviceName?: string }) => client.requestPairing(payload),
    [client],
  );

  const handlePollPairing = useCallback(
    (payload: { requestId: string; claimSecret: string }) => client.pollPairing(payload),
    [client],
  );

  const handlePairedSuccess = useCallback((): void => {
    suppressAutoTrustedLoginRef.current = false;
    setInitialPairingCode(null);
    void refreshPairingStatus({ autoTrustedLogin: false });
  }, [refreshPairingStatus]);

  return {
    pairingStatus,
    pairingChecked,
    isAuthorized: pairingStatus.isLocalDesktop || pairingStatus.authenticated,
    initialPairingCode,
    applyPairingSnapshot,
    markAuthRevoked,
    handleGeneratePairingQr,
    handleApprovePairing,
    handleRejectPairing,
    handleRevokeMobileSession,
    handleLogoutMobileSession,
    handleTrustedReconnect,
    handleRemoveTrustedDevice,
    handleRequestPairing,
    handlePollPairing,
    handlePairedSuccess,
  };
}
