type WriterOptions<Draft, Saved> = {
  draft: Draft;
  saved: Saved | null;
  key: (draft: Draft) => string;
  write: (draft: Draft, base: Saved | null, retry: boolean) => Promise<Saved>;
  accepted: (saved: Saved, draft: Draft) => void;
  state: (state: 'saving' | 'saved' | 'error', error?: unknown) => void;
  keepFailedSnapshot?: (error: unknown) => boolean;
};

/** A single write lane for text, finalization and attachment associations. No browser storage. */
export class DraftWriter<Draft, Saved> {
  private latest: Draft;
  private savedKey: string;
  private saved: Saved | null;
  private lane: Promise<unknown> = Promise.resolve();
  private active = true;
  private queued = 0;
  private failure: unknown = null;
  private pending: { draft: Draft; base: Saved | null } | null = null;
  private options: WriterOptions<Draft, Saved>;
  constructor(options: WriterOptions<Draft, Saved>) {
    this.options = options;
    this.latest = options.draft;
    this.saved = options.saved;
    this.savedKey = options.saved ? options.key(options.draft) : '';
  }
  update(draft: Draft) {
    this.latest = draft;
  }
  get current() {
    return this.saved;
  }
  get dirty() {
    return this.options.key(this.latest) !== this.savedKey;
  }
  get error() {
    return this.failure;
  }
  activate() {
    this.active = true;
  }
  dispose() {
    this.active = false;
  }
  private checkActive() {
    if (!this.active) throw new Error('This editor is no longer active.');
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.queued++;
    const result = this.lane.then(work).finally(() => {
      this.queued--;
    });
    this.lane = result.catch(() => {});
    return result;
  }
  private async drain(): Promise<Saved> {
    this.checkActive();
    if (this.failure) throw this.failure;
    while (this.dirty || !this.saved || this.pending) {
      this.checkActive();
      // An uncertain create/update is retried with its original snapshot and base version.
      const retry = this.pending !== null;
      const request = this.pending || { draft: this.latest, base: this.saved };
      this.pending = request;
      this.options.state('saving');
      try {
        const saved = await this.options.write(request.draft, request.base, retry);
        this.checkActive();
        this.saved = saved;
        this.savedKey = this.options.key(request.draft);
        this.pending = null;
        this.options.accepted(saved, request.draft);
      } catch (error) {
        if (this.options.keepFailedSnapshot?.(error) === false) this.pending = null;
        this.failure = error;
        if (this.active) this.options.state('error', error);
        throw error;
      }
    }
    this.options.state('saved');
    return this.saved!;
  }
  flush(retry = false): Promise<Saved> {
    return this.enqueue(() => {
      if (retry) this.failure = null;
      return this.drain();
    });
  }
  /** Flush current content, then reserve the same lane for a version-changing mutation. */
  exclusive<T>(work: (saved: Saved) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const saved = await this.drain();
      this.checkActive();
      try {
        return await work(saved);
      } catch (error) {
        this.failure = error;
        if (this.active) this.options.state('error', error);
        throw error;
      }
    });
  }
  /** Version-only change: do not replace newer text typed while an attachment was saving. */
  acceptExternal(saved: Saved) {
    this.saved = saved;
  }
  /** Adopt an external save only while no draft, failure, write or association work needs protection. */
  adoptClean(saved: Saved, draft: Draft): boolean {
    if (!this.active || this.queued || this.dirty || this.pending || this.failure) return false;
    this.reset(saved, draft);
    return true;
  }
  /** Explicit conflict resolution; callers must obtain consent before discarding local text. */
  reset(saved: Saved, draft: Draft) {
    this.saved = saved;
    this.latest = draft;
    this.savedKey = this.options.key(draft);
    this.pending = null;
    this.failure = null;
    this.options.accepted(saved, draft);
    this.options.state('saved');
  }
}
