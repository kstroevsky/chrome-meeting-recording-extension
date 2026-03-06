import { LocalFileTarget } from '../src/offscreen/LocalFileTarget';

describe('LocalFileTarget', () => {
  let mockGetDirectory: jest.Mock;
  let mockGetFileHandle: jest.Mock;
  let mockCreateWritable: jest.Mock;
  let mockWrite: jest.Mock;
  let mockClose: jest.Mock;
  let mockGetFile: jest.Mock;
  let mockOnReady: jest.Mock;

  beforeEach(() => {
    mockWrite = jest.fn().mockResolvedValue(undefined);
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockCreateWritable = jest.fn().mockResolvedValue({
      write: mockWrite,
      close: mockClose
    });
    mockGetFile = jest.fn().mockResolvedValue(new Blob(['test']));
    mockGetFileHandle = jest.fn().mockResolvedValue({
      createWritable: mockCreateWritable,
      getFile: mockGetFile
    });
    mockGetDirectory = jest.fn().mockResolvedValue({
      getFileHandle: mockGetFileHandle
    });

    Object.defineProperty(global.navigator, 'storage', {
      value: { getDirectory: mockGetDirectory },
      writable: true
    });

    global.URL.createObjectURL = jest.fn().mockReturnValue('blob:test-url');
    mockOnReady = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('checks availability', async () => {
    const isAvail = await LocalFileTarget.isAvailable();
    expect(isAvail).toBe(true);
    expect(mockGetDirectory).toHaveBeenCalled();
  });

  it('creates and writes chunks', async () => {
    const target = await LocalFileTarget.create('test.webm', mockOnReady);
    
    expect(mockGetDirectory).toHaveBeenCalled();
    expect(mockGetFileHandle).toHaveBeenCalledWith('test.webm', { create: true });
    expect(mockCreateWritable).toHaveBeenCalled();

    const chunk1 = new Blob(['1']);
    const chunk2 = new Blob(['2']);
    
    await target.write(chunk1);
    await target.write(chunk2);

    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(mockWrite).toHaveBeenNthCalledWith(1, chunk1);
    expect(mockWrite).toHaveBeenNthCalledWith(2, chunk2);
  });

  it('recovers from write errors and continues', async () => {
    jest.spyOn(console, 'error').mockImplementationOnce(() => {});
    // Make the first write fail
    mockWrite.mockRejectedValueOnce(new Error('Write failed'));
    
    const target = await LocalFileTarget.create('test.webm', mockOnReady);
    
    await target.write(new Blob(['fail']));
    await target.write(new Blob(['success']));

    expect(mockWrite).toHaveBeenCalledTimes(2); // Second write still attempted
  });

  it('closes and fires onReady', async () => {
    const target = await LocalFileTarget.create('test.webm', mockOnReady);
    await target.close();

    expect(mockClose).toHaveBeenCalled();
    expect(mockGetFile).toHaveBeenCalled();
    expect(global.URL.createObjectURL).toHaveBeenCalled();
    expect(mockOnReady).toHaveBeenCalledWith('blob:test-url', 'test.webm');
  });
});
