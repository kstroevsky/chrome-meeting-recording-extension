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

      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        try { port.onMessage.removeListener(onMessage); } catch {}
        clearTimeout(timer);
        fn();
      };

      const onMessage = (m: any) => {
        // Cast to the typed generic; payload is TRes at this call-site
        const resp = m as RpcResponse<TRes>;
        if (resp && resp.__respFor === id) {
          finish(() => resolve(resp.payload));
        }
      };

      port.onMessage.addListener(onMessage);

      let timer = setTimeout(() => {
        finish(() => reject(new Error('Offscreen response timeout')));
      }, timeoutMs);

      try {
        port.postMessage(msg);
      } catch (e) {
        finish(() => reject(e as any));
      }
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

      // Non-RPC (one-way) message
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
