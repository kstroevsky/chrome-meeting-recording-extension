import type { RpcRequest, RpcResponse } from './protocol';
import { makeId } from './protocol';

type AnyReq = RpcRequest<{ type: string }>;
type HandlerMap = Record<string, (msg: any) => Promise<any> | any>;

export function createPortRpcClient(
  getPort: () => chrome.runtime.Port | null,
  opts?: { timeoutMs?: number }
) {
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  return function rpc<TReq extends AnyReq, TRes = any>(msg: TReq): Promise<TRes> {
    return new Promise((resolve, reject) => {
      const port = getPort();
      if (!port) return reject(new Error('Offscreen port not connected'));

      const id = makeId();
      msg.__id = id;

      const onMessage = (m: any) => {
        const resp = m as RpcResponse;
        if (resp && resp.__respFor === id) {
          try { port.onMessage.removeListener(onMessage); } catch {}
          resolve(resp.payload as TRes);
        }
      };

      port.onMessage.addListener(onMessage);

      try {
        port.postMessage(msg);
      } catch (e) {
        try { port.onMessage.removeListener(onMessage); } catch {}
        return reject(e as any);
      }

      const t = setTimeout(() => {
        try { port.onMessage.removeListener(onMessage); } catch {}
        reject(new Error('Offscreen response timeout'));
      }, timeoutMs);

      // Ensure timer cleared when resolved/rejected
      const cleanup = () => clearTimeout(t);
      // noinspection JSIgnoredPromiseFromCall
      Promise.resolve().then(() => {}).finally(cleanup);
    });
  };
}

export function createPortRpcServer(
  port: chrome.runtime.Port,
  handlers: HandlerMap,
  respond: (reqId: string, payload: any) => void,
  log?: (...a: any[]) => void
) {
  port.onMessage.addListener(async (msg: any) => {
    try {
      const type = msg?.type as string | undefined;
      const reqId = msg?.__id as string | undefined;

      if (!type) return;

      // Only RPC requests have __id; one-way messages are handled elsewhere.
      if (!reqId) {
        const h = handlers[type];
        if (h) await h(msg);
        return;
      }

      const h = handlers[type];
      if (!h) {
        respond(reqId, { ok: false, error: `Unknown RPC type: ${type}` });
        return;
      }

      const payload = await h(msg);
      respond(reqId, payload);
    } catch (e: any) {
      log?.('RPC server error:', e);
      const reqId = msg?.__id as string | undefined;
      if (reqId) respond(reqId, { ok: false, error: String(e?.message || e) });
    }
  });
}
