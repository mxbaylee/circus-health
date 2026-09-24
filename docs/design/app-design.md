# Visual direction: Circus Health

This is the maintained visual direction for the [React application](../../src/README.md), including profile-scoped clinical views, notes, light/dark themes, and responsive layouts. Implemented tokens live in [src/app/tokens.css](../../src/app/tokens.css). Historical reference artwork and mockup studies are kept outside the public repository.

## Visual language

Use a pink, blue, lavender, and cream balance, soft edges, small diamonds, clear outlines, compact silhouettes, divided color panels, stars, and moons. Keep heavy red and navy blocks out of the main identity in favor of quieter accents.

The combination can feel personal and adult: an orderly health notebook with a playful identity. Keep the data area spacious, the text direct and the navigation predictable. Express the theme through a small mark, section accents, selected controls and occasional asymmetric detail, rather than a circus costume around every lab result.

The logo uses three folded hat points converging on a shared diamond, suggesting records from several sources coming together, with a small offset crescent and star. The upper point is rose pink, the left point lavender, the right point sky blue, and the central fold cream with a pale lilac shadow. Preserve the approved geometry and palette across the canonical `src/assets/brand/logo.svg`, the generated React mark, and favicon exports. Decorative sidebar artwork and profile controls must remain visually distinct from clinical status. A mascot is optional; decorative characters should not label clinical results.

## Light theme: paper, pink and sky

Warm near-white background, white reading surfaces, dark plum-charcoal text, muted mauve secondary text. Soft pink and blue are selection fills; deeper berry and teal-blue counterparts carry text and chart lines. This gives the palette contrast without dark red/navy becoming the visual identity.

## Dark theme: quiet night, luminous accents

Charcoal with a slight plum cast, softly raised surfaces, off-white text and desaturated secondary text. Use light rose and sky-blue accents with dark ink for filled buttons. Preserve pink/blue identity rather than simply inverting every color. Images/PDFs retain their original colors and can sit on a neutral viewer surface.

The [proposed token file](app-palette.json) defines starting colors and roles. Values are design candidates, not implemented application CSS. The production interface uses generated fictional data for visual checks.

## Typography, layout and graphic details

- Use a readable system sans-serif body at about 16 px, with a lightly rounded system heading face. Use tabular numerals for measurements and plain monospace only in Raw views. Self-host any custom fonts added later.
- Body text uses comfortable line height; notes have a bounded reading width. Tables keep units close to values and left-align labels. Do not shrink medical text to make a dense dashboard fit.
- Use 8 px spacing increments, 10–14 px surface corners, pill-shaped filters and fine borders. Let most page content sit in open space; group only genuinely related controls/data in a panel.
- Sidebar selected state can use a pink or blue tint with a small diamond. A paired-color heading rule or a tiny star near the app name provides enough character. Decorative shapes stay out of chart data marks and required-status icons.
- Headers can have a slightly playful silhouette; result tables, source documents and warning text remain plain. Avoid confetti, gamified streaks, health-score badges and childish congratulatory copy.
- Use short functional labels: History, By test, Chart this, Compare with, Documents, View source. “Good/bad patient” language and jokes around abnormal results do not belong in this design.

## Screen composition

**Test history:** section title and view tabs, one filter/search row, then a readable chronological list. Each row shows test name, date, value/unit and provider. Panels expand only where the source relationship is known. A clear row target opens details; the explicit chart action has its own label.

**By test:** compact grouped list, not a wall of large cards. “Cholesterol” expands into LDL, HDL, total cholesterol and triglycerides. Each type shows its latest available result date and opens its history/chart. Never mix those component values into one line just because they share a category.

**Detail:** result identity/date at top, a prominent but calm measurement, reference text beside it, and Chart this. Documents and supporting notes follow. Source provenance is one click away without making the main page look like a database inspector.

**Trends:** selected measurement chips and date filter above aligned plots; a point detail panel below or to the right. On small screens plots stack vertically. Each plot has title, date axis, units, source/time range and a visible route to the full table. Chart pink/blue are series identities, not automatic good/bad labels.

**Source library:** folder navigation beside a document/JSON viewer on wide screens; a clear back path on narrow screens. Page navigation, text/raw toggles and source relationships are practical controls, with a neutral document background.

## Accessibility and semantic color

Normal text should meet at least 4.5:1 contrast; large text and meaningful controls/graphics at least 3:1. Validate final rendered pairings, focus indicators, disabled states and charts in both themes; checking token pairs alone does not certify the interface. Soft tints are fills, not low-contrast text. The palette separates subtle decorative borders from stronger control outlines. Focus is visible and not conveyed by a small color change alone. [W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

Reserve semantic warning/error/success roles independently from the pink/blue identity. A source-reported high/low flag must also say High/Low (or retain its original wording); do not rely on red/green. Avoid inferring a flag when the source lacks one unless an explicitly labeled rule is introduced. The theme has no connection to source sex fields or reference-range selection.

Support keyboard navigation, screen-reader labels, generous click targets, zoom/reflow, system theme preference plus a persistent manual override, and reduced motion. Optional transitions should be brief and subtle; no bouncing mascots, continuous animation or effects that delay access to records. Error and empty states give a useful next action without implying that no returned data means no medical history.

## First design review

Judge the build using generated fictional trends, a prescription with several dosage fields, an image/PDF attachment, and a long fictional source note. Check both themes, a narrow viewport, keyboard-only use, and the difference between a source flag and a decorative accent.
