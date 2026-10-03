# Streamed package originals

A retained ZIP member is published from a private disk stage, rather than transported as a whole buffer or base64 response. This lets a large PDF in a ZIP reach the same verified range reader as a directly uploaded PDF. Publication preserves the original ZIP and every selected occurrence; reading a member never accepts clinical records.

## Receipt and publication

The host verifies the profile-owned parent original and opens a regular source file descriptor. The isolated Node inspector receives that descriptor and, for an explicitly selected member, an exclusive output descriptor chosen by the host. Archive names never become extraction destinations. The inspector validates the central directory before reading selected contents, then checks local-header agreement, exact expanded size and CRC while hashing and writing bounded chunks with backpressure. Its response contains metadata and work counters, never the member payload. A progress watchdog and cancellation can stop unfinished work without imposing a fixed total archive-processing deadline.

The host verifies the completed stage's size and SHA-256 against the retained inventory, fsyncs it, and rechecks source identity and processing authorization before publication. The existing original-publication path adopts the stage by rename, or uses an exclusive verified copy across filesystems, then fsyncs the file and directory. The existing selected intake transaction registers the occurrence. Partial or mismatched output never becomes a child original. Only unpublished operation-owned staging is cleaned up; an original that may already be referenced by a durable transaction is preserved after an uncertain response.

Child identity remains bound to parent, exact locator and digest. Repeated access preserves existing workflow state; different names/locators remain separate occurrences even for identical contents. Content equality is not clinical identity. Profile boundaries, retained source integrity and explicit review before acceptance remain unchanged. Staging is private runtime plaintext outside profile snapshot trees; crash leftovers are disposable, never recovery authority.

## Located unfinished work

Package inspection, member extraction and bounded structure failures retain a source-bound pending exception with the original filename/download, the exact member location when known, a sanitized reason and retry action. Unknown scope stays unknown. Repeating the same failure does not add another mutation; successful work resolves only its matching operation and source. A failed inventory cannot claim that every member was read, that the package was empty, or that an invented page was unreadable. Import exposes these failures even when inventory itself fails; model context pages them separately from other workflow sections.

## Current limits

There is no 25 MiB ZIP member-byte cap or 100 MiB aggregate expanded-byte cap on the streamed path. Selection processes one member per operation, so the legacy buffered child API's 300-member/100 MiB-per-call safeguard is not used by ZIP selection. That buffered API still protects other callers, including PDF embedded attachments.

Inventory and extraction-plan metadata still have protective limits: 10,000 central entries, 5,000 files, 2 MiB total encoded filenames and 2,000 characters per filename. The shared plan, role, identity and report contracts still materialize arrays; removing these limits without changing those consumers would not establish bounded memory. Stored and DEFLATE compression are supported; unsafe paths, duplicates, special file types, encrypted members, unsupported compression, corrupt checksums and mismatched headers remain explicit refusals with the parent retained. Nested ZIPs require explicit inventory and retain the three-source-level guard.

Small text/JSON validation and structure inspection remain guarded at 25 MiB. Large original text can be read in bounded windows; complete text capture still has repeated-scan and whole-state costs. PDF page reads use the existing range worker, but parser/output bounds and independent embedded-attachment limits remain. Image/HTML whole-document consumers and configured extraction limits are not made unbounded by this change.

Upload admission and unlock still use the existing configured upload limit and conservative storage estimate. Streaming changes buffer use, not available disk space: expanded children, inventory metadata, encryption, copies, derivatives and concurrent work still need capacity. The storage-only admission goal is unfinished. Its remaining boundaries are [paged inventory and plan authority](../todo/CRS-231.md), [text/JSONL and embedded-file consumers](../todo/CRS-232.md), and [storage admission/operator policy](../todo/CRS-233.md).

## Qualification and work accounting

Use `src/server/test/intake-package-large.test.ts` for fictional direct/package PDF parity and streamed inventory above the old byte caps. Fixtures are generated with bounded blocks outside Git; no health records or provider calls are required. Inspector and staged-child suites separately exercise unsafe metadata, integrity failures, cancellation, publication and retry behavior. Run focused checks using the contributor Node version and qpdf/Tesseract prerequisites in [CONTRIBUTING](../../CONTRIBUTING.md).

Worker counters report decompressed member bytes read, hashed, CRC-checked and written, chunk counts and largest observed payload chunk. The parent [intake file counters](intake-processing-work.md) distinguish whole-buffer reads from streamed verification and publication. These counters cover their named APIs; they are not process RSS, total allocator copies, filesystem physical traffic, encrypted-vault work or model throughput. Metadata memory remains bounded by the retained inventory safeguards. Exact byte counts and direct/package source evidence establish only the exercised local paths, not a provider's clinical completeness or general storage capacity.

The 2026-10-03 fictional qualification exercised 136,315,732 expanded bytes across three occurrences: one stored PDF, one deflated PDF and a second occurrence of the deflated PDF. Inventory read/hashed/CRC-checked exactly that total and wrote no member payload. Selected reads produced these counts:

| Member | Expanded bytes read/hashed/CRC-checked/written by worker | Largest worker payload chunk | Parent streamed verification bytes | Parent whole-buffer file reads/hashes |
| --- | ---: | ---: | ---: | ---: |
| Stored, about 26 MiB | 27,263,260 each | 65,536 | 81,789,780 each read/hashed | 0 |
| Deflated, about 52 MiB | 54,526,236 each | 16,384 | 163,578,708 each read/hashed | 0 |

Each selected publication used three fixed 256 KiB parent inspection allocations; the cumulative 786,432-byte counter is not a simultaneous memory peak. Native page-2 PDF output matched the direct-upload output for both sizes, and the repeated 52 MiB occurrence kept a separate child identity. A late CRC failure recorded all bytes streamed so far without publishing a child. These are two-page fictional PDFs with unreferenced padding, not representative scanned-page or full-history model processing. Current scoped checks include the failed outcome; they do not convert a parser, storage or provider limitation into successful import coverage.

Inventory reuse currently requires a matching active extraction plan. Without one, each inventory page or member read re-inspects and hashes the entire ZIP in its worker. The parent counters above exclude those subprocess inventory passes; the separately measured inventory/selection counters are individual calls, not an end-to-end total. The qualification deliberately exercises unplanned reads as well, but does not claim their repeated inventory work is eliminated. Source-bound inventory reuse and proportional traversal across calls remain part of CRS-231.

## Update and compatibility

Rebuild the application from the reviewed checkout to use streamed member publication. No new environment setting, credential or archive-format migration is required. Located package failures are additive selected intake metadata; use a build that presents them when reviewing unfinished work. An older build can retain these fields without displaying their meaning and still applies its former ZIP byte limits. Do not treat absence of a warning in that build as completed processing. Follow the normal [backup and release comparison](../setup/release-updates.md) procedure; fixture recovery does not promise downgrade compatibility after arbitrary later writes.
