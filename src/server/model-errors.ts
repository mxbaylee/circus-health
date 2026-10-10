/** Leaf error identities shared by model configuration and transport. */
export class ModelError extends Error {}

/** Distinguish a local reading slice from an initial or provider context rejection. */
export class ModelContextLimitError extends ModelError {
  readonly origin: 'slice' | 'initial' | 'provider';
  constructor(message: string, origin: 'slice' | 'initial' | 'provider') {
    super(message);
    this.origin = origin;
  }
}
