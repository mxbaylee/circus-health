/** Fixed names emitted by host diagnostics. Stored keys are untrusted strings too.
 * Extend deliberately with new emitters; unknown historical fields make an event invalid.
 * Values still pass the recorder's existing metadata value validators.
 */
const names = new Set([
  // HTTP, model, import progress and host phases.
  ...`accountedUnits activeMs attempt bytes cachedInputTokens candidates choiceCount chunkCount
  classification currentIndex currentVersion dispatched durationMs errorCategory errorCode
  errorType files hasUsage hashMs hostPreparedPlan inputTokens intakeCount messageCount method
  model operationCount outcome outputTokens pageCount pages pendingReadWindows pendingUnits phase
  plannedDelayMs proposalCount publishMs queueDepth queueWaitKnown queuedWallMs readWindows
  readyRecords reasonCode receivedBytes recoveryAction recoveryAttempt recoveryLimit remainingUnits
  repeatedUpload requestBytes responseBytes route selectedCount slices stagingWriteMs status
  streamWaitMs timeoutMs toolIndex toolName totalTokens totalUnits turns validationCode
  validationPath validationLine pdfParts imageParts traceEventId`.split(/\s+/),
  // Bounded read-window, source revision and version-conflict facts.
  ...`windowOrdinal page readOffset contextSection repeatedWindowCount repeatedWindowLimit
  baselineReadWindows baselineCandidates baselineAccountedUnits progressChanged freshContextStart
  hasSuppliedSourceTextRevision suppliedSourceTextRevisionMatches currentSourceTextRead
  sourceTextChangedSinceRead sourceTextRepairable expectedVersion versionHistoryComplete
  observedVersionChanges lastChangeCategory lastChangeAgeMs identityChanges proposalChanges
  reviewChanges planChanges acceptanceChanges sourceTextChanges questionChanges otherVersionChanges`.split(
    /\s+/,
  ),
  // PDF/evidence preparation timings and counts.
  ...`queueWaitMs sessionSetupMs base64Ms verifyMs textMs renderMs encodeMs annotationMs nativePdfMs
  renderPasses textLayerCharacters pdfBytes imageBytes nativePdfFallback failedNativeReadMs
  reReadCount readHistoryIncomplete firstRead`.split(/\s+/),
  // Process resource samples contain no clinical values or private paths.
  ...`runtimeAvailableBytes tempAvailableBytes filesystemSampleAgeMs filesystemSamplePending scope
  activeProfiles activeScopes cpuPercent cpuUserMicros cpuSystemMicros rssBytes heapUsedBytes
  heapTotalBytes externalBytes arrayBuffersBytes pdfWorkerSeparateProcess pdfWorkerActive
  pdfWorkerRssSampleBytes pdfWorkerMemoryIsLive pdfWorkerSampleAgeMs eventLoopMeanMs eventLoopMaxMs`.split(
    /\s+/,
  ),
  // structuralFields exposes fixed shape counts, never original keys or values.
  ...['request', 'response', 'arguments', 'result'].flatMap((prefix) => [
    ...[
      'Kind',
      'JsonBytes',
      'Nodes',
      'ObjectProperties',
      'ArrayItems',
      'Strings',
      'StringBytes',
      'MaxDepth',
      'Truncated',
    ].map((suffix) => prefix + suffix),
    `has${prefix[0]!.toUpperCase()}${prefix.slice(1)}`,
  ]),
]);
export const isRetainedDiagnosticField = (name: string): boolean => names.has(name);
