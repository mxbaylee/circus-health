# Selected intake envelope authority

The [intake access boundary](../import/intake-state-access.md) stores an original source's complete logical details envelope through the [incremental state primitive](intake-state-storage.md). This lets a High-precision tracker retain unfinished review and accepted decisions without writing another full source row on every workflow change. Originals and accepted record versions remain durable evidence; SQLite and the lookup/search projections remain rebuildable.

## One selected representation

For `intake_original`, `source_files.details_json` contains an explicit `intakeAuthority` marker with format `health-intake-envelope-v1` and mode `normalized` or `raw`, plus compact intake metadata. The selected profile/source/original-hash-bound intake chain owns the complete logical envelope. Its head, contributions, compact source metadata, source pins and accepted clinical changes participate in the existing application transaction.

The compact metadata whitelist is original name, acquisition, current reviewed metadata, received MIME type, creation time, parent source, locator and derivative flag. These fields preserve existing SQL discovery and filtering paths. The compact row is validated against the selected envelope; it does not independently own an operational version, workflow, proposal, decision or acceptance receipt. Unknown surrounding envelope fields remain in the selected envelope rather than being dropped.

Normalized mode stores the complete ordered envelope as the primitive root. Reconstruction therefore preserves the outer member order, intake slot and nested order under the primitive's exact `JSON.stringify` contract. Moving only the intake object into a separate slot and appending it during reconstruction would change search bytes; this representation avoids that problem.

Raw mode stores only `{raw: <exact original string>}` as the primitive root. There is no second normalized operational state. This retains whitespace, duplicate members and escape spelling in an explicitly selected current-format source. Reading, searching, copying and applying separate effective source-pin overlays do not normalize it. Unsupported legacy inline original rows are refused; recognizing current raw mode does not authorize automatic migration of an old archive.

An actual authorized envelope write converts raw mode once to normalized mode in the same transaction. That write has the existing normalization behavior of the application writer. Initial framing of the normalized envelope is a one-time cost and must be counted separately. Ordinary writes cannot switch back to raw mode. Keeping the entire envelope as an edited raw string forever would cause changes near the version and the later workflow to repeatedly emit the growing middle; normalized structural contributions avoid that particular amplification.

Older immutable raw frames remain retained history after a conversion. Only the committed current head and matching source marker select the current representation; historical frames are not a competing authority. Missing, malformed, unsupported, wrongly bound or conflicting selected state refuses rather than resetting an intake or choosing whichever copy is readable.

## Raw metadata and search compatibility

Raw duplicate keys have two existing interpretations that must both survive. SQLite `json_extract` selects the first matching duplicate, while JavaScript `JSON.parse` selects the last. For example, duplicate `sourceProviderId` members can produce a different SQL filter value from the DTO's displayed metadata.

The raw compact projection therefore retains lexical occurrences of the intake member and allowed compact fields, including exact metadata fragments. It removes operational fields while preserving the first/last semantics needed by existing SQL and JavaScript metadata consumers. The complete raw text remains in the selected chain for exact source search and DTO decoding. A compact object created solely from the parsed envelope would silently change filters.

An earlier non-object duplicate `intake` member becomes `null` only in the compact projection. Supported metadata paths below that member still yield no value, and its potentially large contents cannot become a hidden second operational copy. The complete raw authority string remains unchanged; the final parsed intake member must be an object.

Non-original source kinds keep their existing raw envelopes, including intake-shaped metadata and global identity-confirmation lookup behavior. The top-level `intakeAuthority` member is reserved and is refused on non-original sources; changing an original's kind cannot bypass its selected chain. Production operational roots and extracted children use `intake_original`; proposal source envelopes keep their distinct metadata contract.

## Writes, projections and public views

Registration creates compact source identity and its initial selected envelope in the caller's existing publication transaction. Operational writers read through the shared boundary and stage changed contributions, preserving stored versus effective pin versions and the existing stale-review, source-pin, wrong-person and replay rules. Retained V3 reads can expose a complete logical envelope through their bounded compatibility decoder. V4 collection envelopes instead expose explicit intake summaries, selected records, pages and fragments; whole-envelope DTO hydration refuses. Their authenticated handles bind the owner, source identity/hash, logical root and checked compact metadata. A matching head cannot conceal conflicting compact metadata. Complete export is a separate streamed traversal. Stored state and effective pin overlays remain distinct; a presentation page never substitutes for the complete clinical scope.

The compact lookup and exact-text search projections follow the selected intake head as well as source identity. Operational-only mutations can leave compact source metadata unchanged, so `source_files` triggers alone are insufficient. Head insertion, update and deletion invalidate affected derived sources transactionally through indexed namespace bindings. Trigger routing uses the key, not JSON decoding of a possibly corrupt value. Reads validate selected head/profile/source/hash freshness; malformed or removed authority cannot be repaired from an old derived row.

An unpublished mutation failure leaves the prior selected representation intact. A durable head published before a later SQL failure wins on recovery: the live stale projection refuses further work until reopened/rebuilt, and the matching compact marker and envelope return together. Caught staging errors still reject the surrounding transaction. A failed request is not acknowledged as successful merely because later recovery can find its published evidence.

Duplicate-review decisions and assistant classification edits verify the retained originals they depend on, including the physical source carrying the accepted assertion as well as its linked original. A damaged proposal or assertion carrier refuses with `SOURCE_CHANGED`, without acknowledging the decision. This dependency check matters now that an ordinary changed-record publication no longer incidentally hashes an entire portable snapshot.

Contributor model reads now use the same durable source-text capture as encrypted profiles. The assistant must read the relevant current durable passages and pass their revision before proposing interpretation; an original preview alone does not satisfy that requirement. Concurrent automatic reads of the same source share capture work while retaining independent cancellation and callbacks. Explicit extraction keeps its existing busy guard. A retired assistant callback is rejected before reading intake state, and a recovery conflict cannot be disguised by trying to hydrate a stale projection during review retry.

## Copy and recovery

Production copy validates a complete original-to-namespace inventory and compact metadata agreement before destination publication. Missing selected chains and duplicated inline operational state are errors. Preparation preserves raw text and mode or the exact normalized envelope, creates fresh target-bound chains and internal operation identities, and retains public proposal, review, receipt and source-pin identities. Separate profile/path/Self-display rebinding keeps its existing limits.

Manual-source proposals retain their original receipt bytes, author profile, confirmation operation ID and accepted attribution. Both private-copy paths add a separate host-authored proof for each eligible proposal so pending review can retain its explicit manual person assignment in the destination. The proof binds the destination profile, original identity and hash, proposal identity and hash, exact receipt, retained source-text revision and validated source copy head. Preparation verifies the physical evidence and current source authority; staging requires the unchanged source and an unpublished destination inside the copy transaction. The proof is accepted record metadata, so cache-loss reconstruction restores it with the copied intake.

The native manual-receipt profile guard remains unchanged. A foreign receipt alone grants no person assignment. A copied receipt requires the matching destination proof; a missing proof leaves the ordinary review warning and current-profile review flow, while a present malformed or mismatched proof refuses. Current person availability, source-text freshness, physical source verification and acceptance checks still apply. A proof preserves earlier manual attribution; it does not authorize arbitrary foreign-person data or accept a clinical record.

Nested copies validate the source's current proof before creating a fresh destination proof. Earlier proof strings are archived unchanged, and original receipt/authorship strings remain unchanged; an archived proof is not an active destination grant. New manual proposals authored in an intermediate profile retain that authorship when copied again. Existing creation-operation replay and public proposal IDs remain stable.

Encrypted and contributor runtimes use genuine accepted-record durability. A staged copy may validate and prepare evidence before first attachment, but ordinary runtime readers and writers do not bypass configured-current-authority checks. After publication, recovery selects the destination's own latest authority; retry does not recopy an advanced source or rewind an advanced destination.

Copy and recovery validation use private, disk-backed scratch indexes. The manifest and schema-reachability queue each keep their own scratch writes in one transaction for that index's lifetime, instead of committing every copied row or tree visit separately. They are not source-database transactions and do not become recovery authority: completion, refusal, cancellation or generator return closes the private connection and deletes its files. Existing source checks, exact lexical and graph validation, duplicate refusal, fingerprints and cooperative yields remain. The scratch page-cache limit and file-backed temporary storage are unchanged; accepted publication, encryption and synchronization are untouched. No stored-format migration or operator action is required.

The [scratch regressions](../../src/server/test/intake-state-manifest.test.ts) exercise the real cold validator, exact rows at two sizes, and cancellation at an actual schema-validation yield. They count zero per-row autocommit writes, retain duplicate rejection and unchanged source snapshots, and verify that generator return/throw removes the private files without holding a source transaction. These focused results do not replace complete HTTP acceptance and encrypted cache-loss recovery qualification.

### Cold-recovery debugging and scoped schema reads

Cold schema validation and lexical reconstruction request the exact ordered-key prefix
being inspected. The cold graph reader stops at the first authenticated key outside
that prefix instead of filling the remainder of a 64-item page with neighboring
records. Item and byte limits, continuation and count checks, complete name/parent/
order validation, and the separate complete historical graph traversal remain.
The prefix is an optional hint on the internal cell-reader interface: existing and
custom readers can ignore it, and consumers still check every returned key. A
prefix-aware reader refuses a cursor outside the requested prefix. No durable
format, source selection, encryption, publication or cache authority changes.

`intake-recovery-breakdown.test.ts` runs real accepted-journal reconstruction,
manifest copying, historical-graph validation, complete schema/lexical validation,
reattachment and lookup preparation separately on small fictional 4/16-record
hierarchies. It compares the same complete lexical output with a three-argument
reader that ignores the hint. In the measured fixtures, reads fell from 13,611 to
3,632 and 49,399 to 14,763 respectively; read bytes fell from 10,797,183 to 3,488,405
and 41,234,297 to 14,251,768. These are scoped work counts, not a claim about full
HTTP recovery speed. Fixture journal values describe pending fictional intake,
not a completed clinical acceptance or an encrypted-storage performance result.

The encrypted-profile opener uses the existing optional diagnostic spans for
`profile_vault_open`, `profile_workspace_materialize`, `profile_record_replay`,
`profile_intake_validation`, `profile_durability_attach` and `profile_runtime_install`. The acceptance fixture observes only these fixed
phase names and numeric timings, labels unlock separately, and reports request
age and process CPU time. Its observation occurs before normal diagnostic
lifecycle filtering: a locked/uninstalled profile may suppress ordinary stored
events. No diagnostic store is attached early, and a failing optional sink cannot
change recovery. These phases separate operations but are not new time limits.

Run the short reproduction with:

```sh
node --test src/server/test/intake-recovery-breakdown.test.ts src/server/test/profile-recovery-diagnostics.test.ts
```

Then run complete affected corruption/recovery tests and `npm run test:acceptance`.
The original 64-record HTTP acceptance, receipt replay, owned encrypted-cache
removal and recovered clinical/provenance comparisons remain the completion gate.
Neither a small-stage pass nor a timed-out last-operation label proves that gate.

## Work and qualification boundary

The [verified intake work reuse contract](intake-processing-work.md) describes retained V3 materializations, prepared intents, isolated candidate changes and derived-reader reuse. Its detached reads and explicit compatibility conversions retain their validation, serialization and ownership-copy costs. V4 [bounded views](intake-bounded-views.md) and changed-path mutations avoid those full-workflow reads. Complete ordered JSON identity recipes still require counted streaming hashes when new plans or report versions are created. Cold reconstruction and first raw conversion have different costs from warm mutations. Lookup and search work is measured separately, including selected DTO reads and durable readiness-head reads. Compact source rows and bounded contribution frames alone do not prove computation proportional only to changed bytes.

The [activation regressions](../../src/server/test/intake-authority-activation.test.ts) cover exact raw retention, pin overlays, publication failure/recovery and selected-head refusal. A fictional locality case places an unchanged value of 132,000 UTF-8 bytes between an early version and a later workflow field. It counts initial raw conversion separately; the subsequent distant-field edit emits under 4 KiB of contribution frames and under 16 KiB of all accepted writes with no compact source-row update. These bounds describe that regression, not general array/string locality or hundreds of real application mutations.

The [mutation qualification](intake-mutation-qualification.md) records real batch/review/acceptance, copy and recovery evidence and its limits. No installation capacity, full import, live-provider or physical-device qualification follows from this authority contract. The held runner qualification and release gates require their own evidence.
