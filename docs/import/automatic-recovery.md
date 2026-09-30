# Automatic import recovery

## Rationale and authorization

A person importing a long clinical history should not have to babysit arbitrary reading allowances. Productive work continues; recovery isolates the exact work that is stuck while retaining evidence and useful proposals. This implements CRS-126's D2/D3 owner decisions. Provider waiting means unavailable service, not a failed source page, and cannot consume the local stall streak.

Durable automatic-run intent is scheduling state, not an unlock credential. The coordinator checks current permission for the exact profile/import operation at dispatch and publication, independently of browser selection. Generation and source-dependency guards also apply. Closing a tab does not stop authorized work. Lock/logout/profile switch revoke the ordinary runtime; authorized unlock restores eligible automatic work without Resume. Explicit Stop survives restart and unlock.

Restricted import authority after general session access ends remains [CRS-081](../todo/CRS-081.md). Its purpose is to let a person work in another profile without stopping an authorized import or leaving general archive access open (CRS-126 D8). It must reuse this coordinator, retry policy and Stop intent. Clinical acceptance, identity confirmation and browsing still need a live authorized session. Both implementations and their joint journeys are required before claiming the complete post-logout experience; recovery after process loss requires authorized unlock.

## Durable scheduling

Accepted uploads retain an enqueue intent in the same durable transaction as their original metadata. The server reconciles that intent into one batch item, including after a crash between retention and queue creation. Older client enqueue calls reconcile with retained items. Upload and authorized runtime restoration wake the coordinator; browser GETs do not own scheduling.

Eligible items rotate while other files wait. Absolute retry deadlines survive restart. The initial batch snapshot is followed by field deltas proportional to the changed state. Original bytes, proposals, candidate versions and provider receipts retain their separate authorities. A saved explicit Stop stays stopped; recognized historical machine interruptions migrate to automatic continuation, while unrecognized historical pauses stay visible for explicit review.

## Productive work and stalled units

There is no document-wide page, step, elapsed-time, request or token allowance. Individual worker, request, slice and shared-capacity bounds remain. Cumulative usage and unique progress survive continuation; legacy cumulative budgets cannot restore the manual-pause dead end.

Local capture processes one page or text section per checkpoint, rotating between files. Pending capture finishes before a new clinical conversion pins source text. Existing reviewable interpretations prevent background capture from changing their broad source-revision pins. Fine-grained page dependencies remain separate work.

The local watchdog is at least three minutes and twice the longest configured extraction-step timeout: currently six minutes because PDF inventory permits three minutes. Interrupted work retries with a new operation identity from the last durable page. Three failures without progress on the same page retain a located processing-stalled exception, then later pages continue. Missing local OCR is a shared prerequisite with a retry deadline, rather than another failing OCR invocation on every page. Failed initial inventory retains file scope and unknown page count; no page inventory is invented.

Model reading binds a fresh context to an unresolved plan unit before dispatch. A separate three-minute active no-progress window observes newly accounted units, unique read windows and substantive candidate versions. Identical proposals, rereads and successful requests alone do not renew it. Provider/capacity backoff, queued time and locked time do not consume the window. An admitted inference retains its own request deadline; terminal progress is evaluated before admitting another request. Three stalled attempts retain a processing-stalled unit, never an unreadable or completed claim, and other units continue.

**Retry exceptions** reopens retained machine failures without erasing protected human-reviewed text. Human transcription can resolve the matching OCR-unavailable issue only after original/text review validation; it never claims OCR succeeded or resolves unrelated issues.

Source text uses partitioned immutable page/list storage instead of a total page/span/revision-byte ceiling. Decoder, raster and request limits remain. Full-revision editing still has memory costs proportional to document size. A source or capacity failure preserves its original and unresolved scope; it is not proof of complete clinical extraction.

## Provider outcomes

Structured transient/quota failures and unknown outcomes use equal-jitter exponential backoff, starting at five seconds and capped at five minutes before a later provider Retry-After is applied. The actual deadline is durable; retries have no attempt cap. A usable response resets provider backoff separately from unique document progress. Authentication waits for its prerequisite; malformed requests and unsupported capabilities retain automatic intent while waiting for a configuration change or successful explicit connection check. Unchanged rejected input is not sent again on every polling tick. Context-size failures retry with reduced bounded context rather than repeatedly submitting full conversation history.

An unknown request stays unknown and possibly billed. If no recoverable result exists, a durable recovery decision authorizes one replacement request and links it to the predecessor and work unit. Late responses update their actual attempt's accounting; superseded callbacks cannot publish. Retry permission is not proof that the earlier request was free or unsuccessful. No automatic credit purchase, provider switch or clinical acceptance is implied.

The activity explains that retrying an unknown result may use additional provider usage. It distinguishes queued work, extraction/reading, retries, prerequisites, explicit Stop, and Done/Done with exceptions. Waiting is never successful completion. Units read/accounted and exceptions remain separate from proposed clinical records. **Estimating…** remains until observed rates are useful; the broad range combines files and known retry delays, using hours when appropriate. Unknown availability cannot imply a reliable finish time. Estimates and unit accounting are not clinical completeness guarantees.

## Validation boundaries

Fictional regression tests cover durable retry deadlines, repeated transient failures, unknown replacement and late publication guards, productive continuation past former capture limits, located model/local stalls, bounded batch journal writes, encrypted cache-loss recovery, and real server-process loss followed by authorized unlock. Browser journeys cover automatic multi-file upload, explicit Stop/Resume, preserved originals and independent clinical review. These are deterministic contract checks, not measured extraction accuracy or a qualification of every provider, PDF or clinical layout.
