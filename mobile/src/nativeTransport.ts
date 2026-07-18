import {
  registerPlugin,
  type PluginListenerHandle,
} from '@capacitor/core';

export interface PinnedRequestOptions {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  fingerprint: string;
}

export interface PinnedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type PinnedStreamEvent =
  | { connectionId: string; type: 'open' }
  | { connectionId: string; type: 'message'; data?: string }
  | { connectionId: string; type: 'close'; code?: number; reason?: string }
  | { connectionId: string; type: 'error'; code?: string; reason?: string };

export interface PinnedTransportPlugin {
  request(options: PinnedRequestOptions): Promise<PinnedResponse>;
  cancelRequest(options: { requestId: string }): Promise<void>;
  openWebSocket(options: {
    connectionId: string;
    url: string;
    protocols: string[];
    fingerprint: string;
  }): Promise<{ connectionId: string }>;
  closeWebSocket(options: { connectionId: string }): Promise<void>;
  addListener(
    eventName: 'streamEvent',
    listener: (event: PinnedStreamEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export const PinnedTransport = registerPlugin<PinnedTransportPlugin>('PinnedTransport');
