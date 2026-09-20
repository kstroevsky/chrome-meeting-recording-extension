/**
 * A recording a crash left behind is the user's to keep or throw away (8D), so
 * what matters here is that nothing happens to it until they say so.
 */
import { UnsavedRecordingPrompt, type UnsavedRecordingActions } from '../UnsavedRecordingPrompt';

const RECORDING = {
  key: 'staging/meet-team-sync-20260711T1430-recording.webm',
  filename: 'meet-team-sync-20260711T1430-recording.webm',
  sizeBytes: 63 * 1024 * 1024,
  lastModifiedMs: 1_000,
  approxDurationMs: 32 * 60_000,
};

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function make(over: Partial<UnsavedRecordingActions> = {}) {
  const actions: jest.Mocked<UnsavedRecordingActions> = {
    list: jest.fn(async () => [RECORDING]),
    resolve: jest.fn(async () => {}),
    notify: jest.fn(),
    suspended: jest.fn(() => false),
    ...over,
  } as jest.Mocked<UnsavedRecordingActions>;
  return { prompt: new UnsavedRecordingPrompt(actions), actions };
}

const card = () => document.querySelector('.unsaved-recording-overlay');
const input = () => document.querySelector<HTMLInputElement>('.recording-name-input')!;
const save = () => document.querySelector<HTMLButtonElement>('[data-unsaved-save]')!;
const discard = () => document.querySelector<HTMLButtonElement>('[data-unsaved-discard]')!;
const text = (selector: string) => document.querySelector(selector)?.textContent;

afterEach(() => { document.body.replaceChildren(); });

describe('offering back an unsaved recording', () => {
  it('says what was found, in what the design shows', async () => {
    const { prompt } = make();
    await prompt.offerNext();
    await flush();

    expect(text('#unsaved-recording-modal-title')).toBe('Unsaved recording found');
    expect(text('.recording-name-summary')).toBe('~32m · 63 MB · THE MEETING ENDED');
    expect(text('.recording-name-hint'))
      .toBe('The tab closed before this one was saved. It was kept on this device.');
    // The generated name, made readable, so there is something to accept.
    expect(input().value).toBe('Meet Team Sync — 07/11 14:30');
  });

  it('stays silent when there is nothing to offer', async () => {
    const { prompt } = make({ list: jest.fn(async () => []) });
    await prompt.offerNext();
    await flush();
    expect(card()).toBeNull();
  });

  it('saves under the typed name', async () => {
    const { prompt, actions } = make();
    await prompt.offerNext();
    await flush();

    input().value = 'Weekly sync';
    save().click();
    await flush();

    expect(actions.resolve).toHaveBeenCalledWith(RECORDING.key, 'save', 'Weekly sync');
    expect(actions.notify).toHaveBeenCalledWith('Saving the recovered recording');
  });

  it('discards without needing a name', async () => {
    const { prompt, actions } = make();
    await prompt.offerNext();
    await flush();

    input().value = '';
    discard().click();
    await flush();

    expect(actions.resolve).toHaveBeenCalledWith(RECORDING.key, 'discard', undefined);
  });

  it('refuses to save a nameless recording, and writes nothing', async () => {
    const { prompt, actions } = make();
    await prompt.offerNext();
    await flush();

    input().value = '   ';
    input().dispatchEvent(new Event('input'));
    save().click();
    await flush();

    expect(actions.resolve).not.toHaveBeenCalled();
    expect(save().disabled).toBe(true);
  });

  it('keeps the recording when saving fails, so it can be tried again', async () => {
    const { prompt, actions } = make({
      resolve: jest.fn(async () => { throw new Error('Drive is unreachable'); }),
    });
    await prompt.offerNext();
    await flush();
    save().click();
    await flush();

    expect(text('.recording-name-error')).toBe('Drive is unreachable');
    // Still open: a failed save must not look like a decision.
    expect(card()).not.toBeNull();
    expect(actions.notify).not.toHaveBeenCalled();
  });

  it('asks about one recording once, however often the popup asks', async () => {
    const { prompt, actions } = make();
    await prompt.offerNext();
    await flush();
    discard().click();
    await flush();

    await prompt.offerNext();
    await flush();
    expect(actions.resolve).toHaveBeenCalledTimes(1);
  });

  it('never prompts over a preview or a torn-down popup', async () => {
    const { prompt, actions } = make({ suspended: jest.fn(() => true) });
    await prompt.offerNext();
    await flush();
    expect(card()).toBeNull();
    expect(actions.list).not.toHaveBeenCalled();
  });

  it('stays quiet when the lookup itself fails — the bytes are still on disk', async () => {
    const { prompt } = make({ list: jest.fn(async () => { throw new Error('offscreen is gone'); }) });
    await expect(prompt.offerNext()).resolves.toBeUndefined();
    expect(card()).toBeNull();
  });

  it('leaves the length out rather than guessing when the name cannot be read', async () => {
    const { prompt } = make({
      list: jest.fn(async () => [{ ...RECORDING, approxDurationMs: undefined }]),
    });
    await prompt.offerNext();
    await flush();
    expect(text('.recording-name-summary')).toBe('63 MB · THE MEETING ENDED');
  });
});

