;(globalThis as any).__DEV_BUILD__ = false;

// Mock global Chrome API for tests
Object.assign(global, {
  chrome: {
    runtime: {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sendMessage: jest.fn().mockResolvedValue(undefined),
      onMessage: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
      onConnect: {
        addListener: jest.fn()
      },
      connect: jest.fn().mockReturnValue({
        disconnect: jest.fn(),
        onDisconnect: {
          addListener: jest.fn(),
        },
      }),
      getManifest: jest.fn(() => ({
        oauth2: {
          client_id: 'manifest-client-id.apps.googleusercontent.com',
        },
      })),
      getURL: (path: string) => `chrome-extension://mock-id/${path}`,
    },
    offscreen: {
      createDocument: jest.fn(),
      closeDocument: jest.fn(),
      hasDocument: jest.fn().mockResolvedValue(false),
    },
    storage: {
      local: {
        get: jest.fn().mockImplementation(async (keys?: string | string[] | Record<string, unknown>) => {
          if (typeof keys === 'string') return {};
          return {};
        }),
        set: jest.fn().mockResolvedValue(undefined),
      },
      session: {
        get: jest.fn().mockImplementation(async (keys?: string | string[] | Record<string, unknown>) => {
          if (typeof keys === 'string') return {};
          return {};
        }),
        set: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
      },
      onChanged: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
    },
    tabs: {
      query: jest.fn().mockResolvedValue([{ url: 'https://meet.google.com/abc-defg-hij' }]),
      create: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    },
    downloads: {
      download: jest.fn(),
    },
    action: {
      setBadgeText: jest.fn().mockResolvedValue(undefined),
    },
    identity: {
      getAuthToken: jest.fn(),
      removeCachedAuthToken: jest.fn((_details: any, cb?: () => void) => cb?.()),
    }
  }
});

// Polyfill MediaRecorder for jsdom
class MockMediaRecorder {
  static isTypeSupported = jest.fn().mockReturnValue(true);
  start = jest.fn();
  stop = jest.fn();
  ondataavailable: any;
  onstop: any;
  onstart: any;
  onerror: any;
  state: string = 'inactive';
}
(global as any).MediaRecorder = MockMediaRecorder;

// Polyfill getUserMedia
Object.defineProperty(global.navigator, 'mediaDevices', {
  value: {
    getUserMedia: jest.fn().mockResolvedValue({
      getAudioTracks: () => [],
      getVideoTracks: () => [{
        addEventListener: jest.fn(),
      }],
      getTracks: () => [],
    }),
  },
  writable: true
});
