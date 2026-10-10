export interface DiagnosticChunkLimits {
  maxChunkBytes: number;
  maxChunks: number;
  maxBytes: number;
}

export const diagnosticChunkLimits: Readonly<DiagnosticChunkLimits> = Object.freeze({
  maxChunkBytes: 64 * 1024,
  maxChunks: 256,
  maxBytes: 16 * 1024 * 1024,
});
