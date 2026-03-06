// Mock global Chrome API for tests
Object.assign(global, {
  chrome: {
    runtime: {
      sendMessage: jest.fn(),
      onMessage: {
        addListener: jest.fn(),
        removeListener: jest.fn(),
      },
      onConnect: {
        addListener: jest.fn()
      },
      getURL: (path: string) => `chrome-extension://mock-id/${path}`,
    },
    offscreen: {
      createDocument: jest.fn(),
      closeDocument: jest.fn(),
      hasDocument: jest.fn().mockResolvedValue(false),
    },
    storage: {
      session: {
        get: jest.fn().mockResolvedValue({}),
        set: jest.fn(),
      }
    },
    tabs: {
      query: jest.fn().mockResolvedValue([{ url: 'https://meet.google.com/abc-defg-hij' }]),
      sendMessage: jest.fn(),
    },
    downloads: {
      download: jest.fn(),
    },
    action: {
      setBadgeText: jest.fn().mockResolvedValue(undefined),
    },
    identity: {
      getAuthToken: jest.fn(),
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
