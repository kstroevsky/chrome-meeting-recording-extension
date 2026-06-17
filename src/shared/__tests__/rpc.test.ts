import { createPortRpcClient, createPortRpcServer } from '../rpc';

type Listener = (msg: any) => void;

function makeFakePort() {
  const listeners: Listener[] = [];
  return {
    listeners,
    onMessage: {
      addListener: jest.fn((fn: Listener) => listeners.push(fn)),
      removeListener: jest.fn((fn: Listener) => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      }),
    },
    postMessage: jest.fn(),
    /** Simulates the peer delivering a message to every registered listener. */
    deliver(msg: any) {
      for (const fn of [...listeners]) fn(msg);
    },
  };
}

describe('createPortRpcClient', () => {
  it('rejects immediately when no port is connected', async () => {
    const rpc = createPortRpcClient(() => null);
    await expect(rpc({ type: 'OFFSCREEN_STOP' })).rejects.toThrow('Offscreen port not connected');
  });

  it('stamps a request id, posts the message, and resolves the matching response payload', async () => {
    const port = makeFakePort();
    const rpc = createPortRpcClient(() => port as any);

    const msg: any = { type: 'OFFSCREEN_STOP' };
    const pending = rpc(msg);

    // The client assigns __id synchronously before the promise settles.
    expect(typeof msg.__id).toBe('string');
    expect(port.postMessage).toHaveBeenCalledWith(msg);

    port.deliver({ __respFor: msg.__id, payload: { ok: true, value: 42 } });

    await expect(pending).resolves.toEqual({ ok: true, value: 42 });
    // Listener is cleaned up once resolved.
    expect(port.onMessage.removeListener).toHaveBeenCalledTimes(1);
    expect(port.listeners).toHaveLength(0);
  });

  it('ignores responses addressed to a different request id', async () => {
    const port = makeFakePort();
    const rpc = createPortRpcClient(() => port as any);
    const msg: any = { type: 'OFFSCREEN_STOP' };
    const pending = rpc(msg);

    port.deliver({ __respFor: 'someone-else', payload: { ok: false } });
    // Still pending: listener not removed.
    expect(port.onMessage.removeListener).not.toHaveBeenCalled();

    port.deliver({ __respFor: msg.__id, payload: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects with a timeout error when no response arrives in time', async () => {
    jest.useFakeTimers();
    try {
      const port = makeFakePort();
      const rpc = createPortRpcClient(() => port as any, { timeoutMs: 5_000 });
      const pending = rpc({ type: 'OFFSCREEN_STOP' });
      const assertion = expect(pending).rejects.toThrow('Offscreen response timeout');

      jest.advanceTimersByTime(5_000);
      await assertion;
      expect(port.onMessage.removeListener).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects and unsubscribes when postMessage throws', async () => {
    const port = makeFakePort();
    port.postMessage.mockImplementation(() => {
      throw new Error('port closed');
    });
    const rpc = createPortRpcClient(() => port as any);

    await expect(rpc({ type: 'OFFSCREEN_STOP' })).rejects.toThrow('port closed');
    expect(port.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });

  it('settles only once even if a duplicate response is delivered', async () => {
    const port = makeFakePort();
    const rpc = createPortRpcClient(() => port as any);
    const msg: any = { type: 'OFFSCREEN_STOP' };
    const pending = rpc(msg);

    port.deliver({ __respFor: msg.__id, payload: { ok: true, n: 1 } });
    // Second delivery is a no-op because the listener was already removed.
    port.deliver({ __respFor: msg.__id, payload: { ok: true, n: 2 } });

    await expect(pending).resolves.toEqual({ ok: true, n: 1 });
    expect(port.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });
});

describe('createPortRpcServer', () => {
  function wire(handlers: Record<string, (msg: any) => any>) {
    const port = makeFakePort();
    const respond = jest.fn();
    const log = jest.fn();
    createPortRpcServer(port as any, handlers, respond, log);
    return { port, respond, log };
  }

  it('answers an RPC request with the handler payload', async () => {
    const handler = jest.fn().mockResolvedValue({ ok: true, echoed: 'hi' });
    const { port, respond } = wire({ DO_THING: handler });

    port.deliver({ type: 'DO_THING', __id: 'req-1', value: 'hi' });
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith({ type: 'DO_THING', __id: 'req-1', value: 'hi' });
    expect(respond).toHaveBeenCalledWith('req-1', { ok: true, echoed: 'hi' });
  });

  it('invokes the handler for a one-way message without responding', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const { port, respond } = wire({ ONE_WAY: handler });

    port.deliver({ type: 'ONE_WAY' });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
  });

  it('responds with an error for an unknown RPC type', async () => {
    const { port, respond } = wire({});

    port.deliver({ type: 'NOPE', __id: 'req-2' });
    await Promise.resolve();

    expect(respond).toHaveBeenCalledWith('req-2', { ok: false, error: 'Unknown RPC type: NOPE' });
  });

  it('ignores a message with no type', async () => {
    const handler = jest.fn();
    const { port, respond } = wire({ DO_THING: handler });

    port.deliver({ __id: 'req-3' });
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('logs and responds with an error when an RPC handler throws', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('handler boom'));
    const { port, respond, log } = wire({ DO_THING: handler });

    port.deliver({ type: 'DO_THING', __id: 'req-4' });
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith('RPC server error:', expect.any(Error));
    expect(respond).toHaveBeenCalledWith('req-4', { ok: false, error: 'handler boom' });
  });

  it('logs but does not respond when a one-way handler throws', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('one-way boom'));
    const { port, respond, log } = wire({ ONE_WAY: handler });

    port.deliver({ type: 'ONE_WAY' });
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toHaveBeenCalledWith('RPC server error:', expect.any(Error));
    expect(respond).not.toHaveBeenCalled();
  });
});
