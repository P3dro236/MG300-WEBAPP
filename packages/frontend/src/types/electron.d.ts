import type { MgControlDesktopBridgeV1 } from '@quicktone/shared';

export type { MgControlDesktopBridgeV1 };

declare global {
  interface Window {
    mgControl?: MgControlDesktopBridgeV1;
  }
}
