import { IDBFactory } from 'fake-indexeddb';
import { RetainedPrimaryOutbox } from '../RetainedPrimaryOutbox';
import { createIndexedDbKeyValueArea, type KeyValueArea } from '../indexedDbKeyValueArea';

const request = {
  historyId: 'recording:1',
  destinationId: 'destination_crm',
  stream: 'tab' as const,
  filename: 'interview.webm',
  bytes: 123,
  startOffsetMs: 45,
  retainedKey: 'library/recording%3A1/recording%3A1%3Atab/interview.webm',
  retainedAt: 99,
};

function memoryArea(): KeyValueArea {
  const data: Record<string, unknown> = {};
  return {
    getAll: async () => ({ ...data }),
    set: async (items) => { Object.assign(data, items); },
    remove: async (key) => { delete data[key]; },
  };
}

describe('RetainedPrimaryOutbox', () => {
  it('holds a retained-media handoff until its exact recording stream is acknowledged', async () => {
    const outbox = new RetainedPrimaryOutbox(memoryArea());

    await outbox.put(request);
    expect(await outbox.list()).toEqual([request]);

    await outbox.remove(request.historyId, request.stream);
    expect(await outbox.list()).toEqual([]);
  });

  it('keeps independent primary streams in separate durable rows', async () => {
    const outbox = new RetainedPrimaryOutbox(memoryArea());
    await outbox.put(request);
    await outbox.put({ ...request, stream: 'mic', filename: 'mic.webm', retainedKey: 'library/mic.webm' });

    expect((await outbox.list()).map((item) => item.stream).sort()).toEqual(['mic', 'tab']);

    await outbox.remove(request.historyId, 'tab');
    expect((await outbox.list()).map((item) => item.stream)).toEqual(['mic']);
  });

  it('survives an offscreen restart through IndexedDB', async () => {
    const factory = new IDBFactory();
    const area = () => createIndexedDbKeyValueArea({
      databaseName: 'retained-primary-outbox-test',
      storeName: 'handoffs',
      factory,
    });
    await new RetainedPrimaryOutbox(area()).put(request);

    expect(await new RetainedPrimaryOutbox(area()).list()).toEqual([request]);
  });

  it('drops malformed durable rows instead of broadening a handoff', async () => {
    const area = memoryArea();
    await area.set({
      'retainedPrimary:bad:tab': { ...request, destinationId: '', bytes: -1 },
      'retainedPrimary:good:tab': request,
    });

    expect(await new RetainedPrimaryOutbox(area).list()).toEqual([request]);
  });
});
