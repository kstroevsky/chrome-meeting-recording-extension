import { managedShares, type ManagedShare } from '../sharing/ShareManagementModel';
import type { ShareRuntimeSnapshot } from '../sharing/ShareRuntime';

export type SharedViewActions = {
  load: () => Promise<ShareRuntimeSnapshot>;
  revoke: (shareId: string) => Promise<void>;
  delete: (shareId: string) => Promise<void>;
};

/** Server-backed share management surface. Local publication state only enriches progress. */
export class SharedView {
  private shares: ManagedShare[] = [];
  private refreshing = false;

  constructor(
    private readonly list: HTMLElement,
    private readonly empty: HTMLElement,
    private readonly error: HTMLElement,
    private readonly actions: SharedViewActions,
  ) {}

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const snapshot = await this.actions.load();
      this.shares = managedShares(snapshot);
      this.error.textContent = snapshot.remoteError
        ? `Server registry unavailable; showing durable local state. ${snapshot.remoteError}`
        : '';
      this.error.hidden = !this.error.textContent;
      this.render();
    } catch (cause) {
      this.error.textContent = cause instanceof Error ? cause.message : String(cause);
      this.error.hidden = false;
    } finally {
      this.refreshing = false;
    }
  }

  private render(): void {
    this.empty.hidden = this.shares.length > 0;
    this.list.replaceChildren(...this.shares.map((share) => this.card(share)));
  }

  private card(share: ManagedShare): HTMLElement {
    const card = document.createElement('article');
    card.className = 'shared-card';
    card.dataset.shareId = share.id;

    const head = document.createElement('div');
    head.className = 'shared-card__head';
    const titles = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = share.recordingTitles.join(' · ') || 'Published recording';
    const meta = document.createElement('p');
    meta.className = 'shared-card__meta';
    meta.textContent = `Created ${new Date(share.createdAt).toLocaleString()} · ${share.trackCount} track${share.trackCount === 1 ? '' : 's'}`;
    titles.append(title, meta);
    const state = document.createElement('span');
    state.className = `shared-card__state shared-card__state--${share.status}`;
    state.textContent = share.phaseLabel;
    head.append(titles, state);
    card.append(head);

    if (share.totalBytes != null && share.percent != null && share.status !== 'active' && share.status !== 'revoked') {
      const progress = document.createElement('div');
      progress.className = 'shared-card__progress';
      const bar = document.createElement('span');
      bar.className = 'shared-card__progress-bar';
      bar.style.width = `${share.percent ?? 0}%`;
      const label = document.createElement('small');
      label.textContent = `${formatBytes(share.uploadedBytes)} / ${formatBytes(share.totalBytes)} · ${share.percent ?? 0}%${share.resumable ? ' · resumable' : ''}`;
      progress.append(bar, label);
      card.append(progress);
    }

    if (share.error) {
      const error = document.createElement('p');
      error.className = 'shared-card__error';
      error.textContent = share.error;
      card.append(error);
    }

    const actions = document.createElement('div');
    actions.className = 'shared-card__actions';
    if (share.shareUrl && share.status === 'active') {
      actions.append(
        this.button('Copy link', () => this.copy(share.shareUrl!)),
        this.button('Open', () => window.open(share.shareUrl!, '_blank', 'noopener')),
      );
      actions.append(this.button('Revoke', () => this.revoke(share.id), 'shared-card__button--danger'));
    }
    actions.append(this.button('Delete published data', () => this.remove(share), 'shared-card__button--danger'));
    card.append(actions);
    return card;
  }

  private button(label: string, action: () => void, extra = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `shared-card__button ${extra}`.trim();
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  private async copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      this.error.textContent = 'Could not copy the link automatically.';
      this.error.hidden = false;
    }
  }

  private async revoke(shareId: string): Promise<void> {
    try {
      await this.actions.revoke(shareId);
      await this.refresh();
    } catch (cause) {
      this.showActionError(cause);
    }
  }

  private async remove(share: ManagedShare): Promise<void> {
    const titles = share.recordingTitles.join(', ') || 'this published copy';
    if (!window.confirm(`Permanently delete published data for ${titles}? The link will be revoked and stored media will be destroyed.`)) return;
    try {
      await this.actions.delete(share.id);
      await this.refresh();
    } catch (cause) {
      this.showActionError(cause);
    }
  }

  private showActionError(cause: unknown): void {
    this.error.textContent = cause instanceof Error ? cause.message : String(cause);
    this.error.hidden = false;
  }
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GB` : `${Math.max(0, Math.round(mib))} MB`;
}
