# Option 1 design QA

## Source and implementation

- Reference: `/var/folders/dy/fl46t519257556qw_g6l7tgw0000gp/T/codex-clipboard-a9dd7950-0b55-4647-8cbb-84ac12864377.png`
- Reference viewport: 726 × 1536
- Final implementation capture: `design-qa-option1-final-2.png`
- Matching viewport and state: 726 × 1536, create screen after the character-by-character intro completed
- Responsive create capture: `design-qa-mobile-390-final.png` at 390 × 844
- Supporting full-page captures:
  - `design-qa-feedback-final.png`
  - `design-qa-explore-final.png`
  - `design-qa-privacy-final.png`

The source and final implementation were opened together in the same visual comparison input. The create screen is a single-column composition, and the matching 726 × 1536 capture shows its complete meaningful area at readable scale, so a separate cropped region would duplicate rather than clarify the comparison. The route-level full-page captures cover the longer supporting screens.

## Visual comparison

- Composition: matched the reference's centered narrow column, large opening whitespace, restrained header, oversized mono headline, large prompt field, four inline size choices, and single orange action.
- Brand: retained the supplied ASCII gênio mark, monochrome surfaces, hairline borders, and the orange selection/action language.
- Hierarchy: removed redundant numbered section labels and converted the product to the same direct title → explanation → action rhythm on every screen.
- Navigation: established one consistent CREATE / EXPLORE / JOBS structure, with a separate utility menu for feedback and privacy.
- Responsive behavior: preserved the same hierarchy at 390 px without horizontal overflow; touch targets remain at least 44 × 44 px.
- Supporting screens: Explore, Jobs, guided questions, research progress, track selection, publishing, results, feedback, privacy, and the owner console use the same typography, spacing, borders, status colors, and button treatment.

## Iteration history

1. Initial implementation matched the visual language but sat too high, used an undersized wordmark/navigation, and allowed the selected-size underline to span the full cell.
2. Increased the reference-viewport top rhythm, scaled the official ASCII mark and nav, narrowed the selection underline, enlarged the primary action, and restored 44 px control targets.
3. Raised low-contrast secondary text, added visible orange focus treatment, repaired focus transfer after the intro and feedback submission, prevented feedback auto-focus from skipping the page header, and clarified partial Apple-link gaps in Explore.

## Interaction and accessibility checks

- Create, Explore, and Jobs navigation are distinct and expose the current location.
- `/?view=jobs` is reloadable; CREATE resets the builder and returns to `/`.
- Preset and custom track counts remain keyboard-operable and preserve exact-count validation.
- The prompt receives focus when the intro finishes; reduced-motion visitors skip the animation.
- Guided choices, track checkboxes, matching alternatives, publication actions, feedback upload, and owner controls retain their existing functionality.
- Visible keyboard focus, WCAG-AA text contrast, reduced-motion behavior, and 44 px mobile targets are preserved.
- Local API-dependent Explore correctly rendered its designed recoverable error state while the local gateway was unavailable; no render or navigation failure occurred.

## Final result

`passed`
