# gênio minimalist composer — design QA

## Comparison target

- User-selected source: `/Users/mlima/Desktop/Screenshot 2026-07-16 at 11.30.08 PM.png`
- Desktop implementation: `/tmp/genio-composer-752-v2.png`
- Mobile implementation: `/tmp/genio-composer-320-v2.png`
- Custom-size implementation: `/tmp/genio-custom-390.png`
- Side-by-side evidence: `/tmp/genio-design-comparison.png`
- Viewports: 752 × 1628, 390 × 844, and 320 × 720 CSS pixels
- Route/state: local `/`; dark theme; empty request; default 50-track preset; custom 275-track state

## Findings

- No actionable P0, P1, or P2 differences remain.
- The unused vertical rail is gone. Request, size, and create remain one calm, linear screen without sacrificing the source hierarchy.
- The top-left mark and animated introduction share one native ASCII `gênio` wordmark. The visible circumflex is built into the ASCII art, while accessible text reads `gênio`.
- Product copy uses `gênio`; `9enio.com` remains only the web address and technical namespace.
- Track quantity is reduced to three useful presets—25, 50, and 100—plus Custom. Custom replaces the preset row with an exact numeric field and a clear route back to presets.
- Custom quantities accept whole numbers from 1 through 300. The visible validation message, timing estimate, and create control update together without coercing malformed values.
- The later research, track-selection, publish, and result screens use the same near-black surfaces, hairline borders, compact labels, restrained orange, and narrower type hierarchy.
- Desktop and mobile captures show no horizontal overflow, clipping, or abandoned rail space. Header controls remain usable at 320 pixels.
- Focus states, touch targets, reduced motion, intro skip, keyboard navigation, and the custom-count transition are covered by responsive browser tests.

## Comparison history

1. Initial source review
   - [P1] The left progress rail consumed substantial mobile space without enabling an action.
   - [P1] The text mark mixed `9ênio` and `gênio`, while the supplied ASCII asset was not consistently reused.
   - [P2] Four fixed quantity choices did not expose arbitrary playlist sizes.
   - [P2] Later screens retained a larger, noisier hierarchy than the simplified composer.
2. Implementation pass
   - Removed the rail and re-centered the workflow.
   - Introduced one shared ASCII wordmark for the header and typed intro.
   - Replaced the quantity row with 25 / 50 / 100 / Custom and a validated 1–300 exact input.
   - Simplified subsequent screen labels, headings, CTAs, and result copy.
3. Responsive QA pass
   - Increased small-screen ASCII legibility, preserved Share Job in active runs, blocked intro pointer leakage, normalized focus behavior, and replaced the stale social image.

## Implementation checklist

- [x] Remove the left rail.
- [x] Use the official ASCII-style `gênio` logo consistently.
- [x] Reserve `9enio` for the domain and technical keys.
- [x] Offer three presets plus a morphing Custom control.
- [x] Enforce and explain a 1–300 playlist-size limit.
- [x] Redesign the downstream research, review, publish, and result states.
- [x] Verify 320, 390, 430, and desktop layouts.
- [x] Verify keyboard, touch, reduced-motion, and intro behavior.

final result: passed
