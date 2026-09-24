import { formatBytes } from '../shared/format';
import { sendToBackground } from '../shared/messages';
import type { IntegrationDataPolicy, TranscriptSpeakerPolicy } from '../integrations/contracts';
import type { IntegrationPayloadPreview } from '../integrations/preview';

type PreviewElements = {
  recording: HTMLSelectElement | null;
  metadata: HTMLElement | null;
  output: HTMLTextAreaElement | null;
  preview: HTMLButtonElement | null;
  download: HTMLButtonElement | null;
  status: HTMLElement | null;
  speakers: HTMLSelectElement | null;
  policyInputs: NodeListOf<HTMLInputElement>;
};

export class IntegrationPreviewController {
  private lastPreview: IntegrationPayloadPreview | undefined;
  private lastRecordingName = 'recording';

  constructor(private readonly el: PreviewElements) {}

  static fromDocument(doc: Document): IntegrationPreviewController {
    return new IntegrationPreviewController({
      recording: doc.getElementById('integration-preview-recording') as HTMLSelectElement | null,
      metadata: doc.getElementById('integration-preview-meta'),
      output: doc.getElementById('integration-preview-output') as HTMLTextAreaElement | null,
      preview: doc.getElementById('integration-preview-build') as HTMLButtonElement | null,
      download: doc.getElementById('integration-preview-download') as HTMLButtonElement | null,
      status: doc.getElementById('integration-preview-status'),
      speakers: doc.getElementById('integration-preview-speakers') as HTMLSelectElement | null,
      policyInputs: doc.querySelectorAll<HTMLInputElement>('[data-integration-policy]'),
    });
  }

  async init(): Promise<void> {
    this.el.preview?.addEventListener('click', () => void this.buildPreview());
    this.el.download?.addEventListener('click', () => this.downloadPreview());
    this.el.recording?.addEventListener('change', () => this.invalidate());
    this.el.speakers?.addEventListener('change', () => this.invalidate());
    this.el.policyInputs.forEach((input) => input.addEventListener('change', () => this.invalidate()));
    await this.loadRecordings();
  }

  private async loadRecordings(): Promise<void> {
    if (!this.el.recording) return;
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
      if (!response.ok) throw new Error(response.error);
      this.el.recording.replaceChildren(...response.entries.map((entry) => {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.name;
        return option;
      }));
      const hasRecordings = response.entries.length > 0;
      if (this.el.preview) this.el.preview.disabled = !hasRecordings;
      this.setStatus(hasRecordings ? 'Ready to build a local fixture.' : 'No finished recordings available.');
    } catch (error) {
      if (this.el.preview) this.el.preview.disabled = true;
      this.setStatus(`Preview unavailable: ${String(error)}`, true);
    }
  }

  private async buildPreview(): Promise<void> {
    const recordingId = this.el.recording?.value;
    if (!recordingId) return;
    this.setStatus('Building fixture…');
    try {
      const response = await sendToBackground({
        type: 'PREVIEW_INTEGRATION_PAYLOAD',
        recordingId,
        policy: this.readPolicy(),
      });
      if (!response.ok) throw new Error(response.error);
      this.lastPreview = response.preview;
      this.lastRecordingName = this.el.recording?.selectedOptions[0]?.textContent?.trim() || 'recording';
      if (this.el.output) this.el.output.value = response.preview.body;
      if (this.el.metadata) {
        const pending = response.preview.readiness.pending.length
          ? `pending ${response.preview.readiness.pending.join(', ')}`
          : 'complete';
        this.el.metadata.textContent = [
          response.preview.eventType,
          `schema ${response.preview.schemaVersion}`,
          `revision ${response.preview.revision}`,
          pending,
          `${formatBytes(response.preview.totalBytes)} JSON`,
        ].join(' · ');
      }
      if (this.el.download) this.el.download.disabled = false;
      this.setStatus('Fixture built from current local recording state.');
    } catch (error) {
      this.invalidate();
      this.setStatus(`Preview failed: ${String(error)}`, true);
    }
  }

  private readPolicy(): IntegrationDataPolicy {
    const enabled = new Set(
      Array.from(this.el.policyInputs)
        .filter((input) => input.checked)
        .map((input) => input.dataset.integrationPolicy),
    );
    return {
      metadata: true,
      meetingIdentity: enabled.has('meetingIdentity'),
      userNote: enabled.has('userNote'),
      notations: enabled.has('notations'),
      transcript: enabled.has('transcript'),
      analysis: enabled.has('analysis'),
      artifactMetadata: enabled.has('artifactMetadata'),
      artifactLinks: enabled.has('artifactLinks'),
      transcriptSpeakers: normalizeSpeakerPolicy(this.el.speakers?.value),
    };
  }

  private downloadPreview(): void {
    if (!this.lastPreview) return;
    const blob = new Blob([this.lastPreview.body], { type: 'application/cloudevents+json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${filenameStem(this.lastRecordingName)}-integration-event.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private invalidate(): void {
    this.lastPreview = undefined;
    if (this.el.download) this.el.download.disabled = true;
    if (this.el.output) this.el.output.value = '';
    if (this.el.metadata) this.el.metadata.textContent = '';
  }

  private setStatus(message: string, error = false): void {
    if (!this.el.status) return;
    this.el.status.textContent = message;
    this.el.status.dataset.error = String(error);
  }
}

function normalizeSpeakerPolicy(value: string | undefined): TranscriptSpeakerPolicy {
  return value === 'names' || value === 'omit' ? value : 'pseudonyms';
}

function filenameStem(value: string): string {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return normalized || 'recording';
}
