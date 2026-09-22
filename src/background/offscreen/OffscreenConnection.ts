import { createPortRpcClient } from '../../shared/rpc';
import type { BgToOffscreenOneWay, BgToOffscreenRpc } from '../../shared/protocol';
import { TIMEOUTS } from '../../shared/timeouts';

export class OffscreenConnection {
  private port: chrome.runtime.Port | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((reason?: unknown) => void) | null = null;

  private readonly rpcClient = createPortRpcClient(
    () => this.port,
    { timeoutMs: TIMEOUTS.RPC_MS },
  );

  get currentPort(): chrome.runtime.Port | null {
    return this.port;
  }

  get isReady(): boolean {
    return this.ready;
  }

  attach(
    port: chrome.runtime.Port,
    onMessage: (msg: unknown) => void,
    onDisconnected: () => void,
    preserveReadyOnDisconnect: () => boolean,
  ): void {
    this.port = port;
    this.ready = false;
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this.ready = false;
      onDisconnected();
      if (!preserveReadyOnDisconnect()) this.resetReadyPromise();
    });
  }

  markReady(): void {
    this.ready = true;
    this.resolveReady?.();
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
  }

  markNotReady(): void {
    this.ready = false;
  }

  getOrCreateReadyPromise(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
    }
    return this.readyPromise;
  }

  resetReadyPromise(): void {
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  failReady(reason: unknown): void {
    this.rejectReady?.(reason);
    this.resetReadyPromise();
  }

  clearPort(disconnect = false): void {
    const port = this.port;
    this.port = null;
    this.ready = false;
    if (!disconnect) return;
    try {
      port?.disconnect();
    } catch {}
  }

  rpc<TRes = any>(msg: BgToOffscreenRpc): Promise<TRes> {
    return this.rpcClient<BgToOffscreenRpc, TRes>(msg);
  }

  post(message: BgToOffscreenOneWay): void {
    try {
      this.port?.postMessage(message);
    } catch {}
  }
}
