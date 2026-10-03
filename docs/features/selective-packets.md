# Choose what a packet shares

Print / Export prepares a packet for one person. It keeps the person's complete private collection and accepted history intact. The [Privacy-sensitive patient and Caregiver's sharing job](../design/personas.md#share-a-packet) uses the same choices for the preview, PDF, evidence JSON and accompanying original downloads.

## Prepare and review

1. Open Print / Export from the person's profile or a saved note. Choose a provider packet or the note's visit brief.
2. Choose record kinds, an explicit date window or tags you assigned yourself. Adjust individual records when the category choice needs an exception. These choices do not infer sensitivity or clinical relevance.
3. Mark a record **Always leave out of packets** when the choice should apply to later packets too. Change that saved preference deliberately before including the record again. Tags and this preference are personal metadata, separate from clinical evidence.
4. Prepare the preview. The private review shows the actual records left out, their titles, counts and empty categories. This review stays outside the printable page and shared evidence file.
5. Review any offered unredacted material before including it. Regenerate the preview after changing choices, then download the PDF, evidence file and any listed companions.

An empty selected category does not mean the person has no such history. Job presets, reviewed Conditions/status summaries and a one-page emergency layout remain separate [open work](../todo/CRS-150.md).

Date filtering uses each clinical record's recorded date. An authored note uses its event date when present, otherwise its last modification date; the list labels that distinction. A personal medication confirmation does not supply a missing clinical date. Undated or imprecisely dated records need an individual inclusion choice to enter a dated packet.

## Shared disclosure and unredacted material

When the person withholds records, the shared packet says “Some records were left out at the patient's request.” It does not list or count the withheld records. Records with unresolved ownership and unread or partly reviewed sources have separate disclosures; those limitations are not presented as the person's choice.

A record filter cannot reliably find repeated information inside arbitrary prose, raw source objects or original files. When withholding applies, unchecked narratives, raw/context payloads and companions are withheld by default. Selected structured fields remain recorded clinical values; this is not a semantic redaction service.

Known conflicts are derived from retained source/evidence relationships, attachment owners and identical original hashes. A result and a condition can share a file even when their record identifiers differ. A copied original does not lose its restriction merely because it has a different filename.

The user can explicitly approve an offered unredacted item for a packet. That approval is tied to the exact reviewed material and selection. The shared packet then explains that unredacted material may contain information absent from the selected record summary. The exception cannot bypass an active persistent withholding preference connected to that material. Change the saved preference first if sharing it is intended.

The private inspection covers every section and metadata field that the approval shares. Note text, questions, raw thoughts and correction details have separate readable sections, with all raw fields still available. Long inspections offer a complete private download alongside their clearly shortened on-screen preview. Original inspection opens the complete retained bytes; nonessential attachment captions are excluded from shared companion metadata. These private inspection controls are separate from the packet's approved download list.

An original is never edited in place. An offered original retains its complete bytes; the packet does not claim those bytes were redacted. Unknown textual relationships cannot be proven absent by a record-ID filter. Review included material and the final shared outputs before sending them.

## Frozen choices and downloads

The preview fingerprint covers the subject, selection, resolved membership, relevant saved preferences, actor and approval metadata, included content and companion evidence. Editing choices in the dialog requires a refreshed preview before sharing. Changed relevant records or saved preferences invalidate older previews. Each preview keeps its own one-time choices: preparing a separate packet does not revoke another packet's unchanged preview. Expiring preview tokens are profile scoped and do not survive a server restart.

Changing a choice cannot recall a file already downloaded, printed or sent. Review the refreshed outputs before sharing them.

Companion downloads pass the same preview validation and membership checks as the PDF and evidence file. The server verifies the selected original's bytes before returning it. PDF and evidence download names are generic, so an excluded initiating note's title cannot appear in the shared filename. Normal private access to the original through the app remains available; exclusion governs the packet, not the person's own collection.

Private selection details never become an appendix in shared JSON. Shared output uses an explicit projection. In a selective packet, source context, narrative metadata and correction details that may repeat withheld content do not bypass the same boundary through a citation or raw field. The [export contract](../../src/server/NOTE-EXPORTS.md) describes the API and output limitations.

## Saved preferences and recovery

Saved preferences identify a person and a stable record, with manually assigned tags, the withholding flag, version and profile-user attribution. Each mutation journals changed preference data rather than a source, record collection or growing history snapshot. A no-op saves nothing. Concurrent edits require reloading the current preference version.

Accepted reclassification and ownership redirects must not silently defeat withholding. A restrictive preference follows the resolved record; changing it remains an explicit profile-user action. Another person's private tags are not exposed by an ownership correction.

Current supported recovery and export paths preserve these preferences separately from accepted clinical evidence and originals. A previous app version that does not implement packet withholding cannot enforce it. Use an app version that supports these choices before sharing a recovered collection; see [release and format notes](../setup/release-updates.md#release-configuration-and-format-notes).
