import {
  resumePendingDriveUploads,
  type ResumePendingUploadsDeps,
} from '../src/offscreen/drive/resumePendingUploads';
import type { PendingUpload, PendingUploadStore } from '../src/offscreen/drive/PendingUploadStore';

function fakeStore(initial: PendingUpload[]) {
  const data = new Map<string, PendingUpload>();
  for (const e of initial) data.set(e.opfsFilename, e);
  return {
    list: jest.fn(async () => [...data.values()]),
    remove: jest.fn(async (name: string) => { data.delete(name); }),
    put: jest.fn(async () => {}),
  } as unknown as PendingUploadStore & { list: jest.Mock; remove: jest.Mock; put: jest.Mock };
}

const entry = (name: string): PendingUpload => ({
  opfsFilename: name,
  filename: name,
  stream: 'tab',
  recordingFolderName: 'folder',
});

const blob = (size: number) => ({ size } as Blob);

function makeDeps(over: Partial<ResumePendingUploadsDeps> = {}): ResumePendingUploadsDeps {
  return {
    store: fakeStore([]),
    log: jest.fn(),
    warn: jest.fn(),
    openOpfsFile: jest.fn(async () => blob(100)),
    removeOpfsFile: jest.fn(async () => {}),
    fixDuration: jest.fn(async (raw) => raw),
    uploadFile: jest.fn(async () => {}),
    ...over,
  };
}

describe('resumePendingDriveUploads', () => {
  it('does nothing when there are no pending uploads', async () => {
    const deps = makeDeps({ store: fakeStore([]) });
    await resumePendingDriveUploads(deps);
    expect(deps.uploadFile).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('re-fixes, uploads fresh, then clears the marker and the OPFS file', async () => {
    const store = fakeStore([entry('a.webm')]);
    const deps = makeDeps({ store });

    await resumePendingDriveUploads(deps);

    expect(deps.fixDuration).toHaveBeenCalledTimes(1);
    expect(deps.uploadFile).toHaveBeenCalledTimes(1);
    expect(store.remove).toHaveBeenCalledWith('a.webm');
    expect(deps.removeOpfsFile).toHaveBeenCalledWith('a.webm');
  });

  it('drops a marker whose OPFS file is gone, without uploading', async () => {
    const store = fakeStore([entry('a.webm')]);
    const deps = makeDeps({ store, openOpfsFile: jest.fn(async () => null) });

    await resumePendingDriveUploads(deps);

    expect(deps.uploadFile).not.toHaveBeenCalled();
    expect(store.remove).toHaveBeenCalledWith('a.webm');
    expect(deps.removeOpfsFile).not.toHaveBeenCalled();
  });

  it('drops a marker whose OPFS file is empty', async () => {
    const store = fakeStore([entry('a.webm')]);
    const deps = makeDeps({ store, openOpfsFile: jest.fn(async () => blob(0)) });

    await resumePendingDriveUploads(deps);

    expect(deps.uploadFile).not.toHaveBeenCalled();
    expect(store.remove).toHaveBeenCalledWith('a.webm');
  });

  it('leaves the marker and the OPFS file in place when the upload fails', async () => {
    const store = fakeStore([entry('a.webm')]);
    const deps = makeDeps({
      store,
      uploadFile: jest.fn(async () => { throw new Error('network down'); }),
    });

    await resumePendingDriveUploads(deps);

    expect(store.remove).not.toHaveBeenCalled();
    expect(deps.removeOpfsFile).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalled();
  });

  it('processes each pending entry independently (one failure does not block the rest)', async () => {
    const store = fakeStore([entry('a.webm'), entry('b.webm')]);
    let calls = 0;
    const deps = makeDeps({
      store,
      uploadFile: jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('first fails');
      }),
    });

    await resumePendingDriveUploads(deps);

    expect(deps.uploadFile).toHaveBeenCalledTimes(2);
    expect(store.remove).toHaveBeenCalledWith('b.webm');
    expect(store.remove).not.toHaveBeenCalledWith('a.webm');
  });
});
