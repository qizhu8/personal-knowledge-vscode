# Academy Feedback System

Personal Knowledge Manager uses a restrained magical-academy language for domain icons, motion, and transient progress feedback. The content itself remains academic and professional.

## Content Boundary

- Keep titles, tabs, buttons, fields, errors, warnings, and stored content literal and professional.
- Use playful language only for transient loading, synchronization, discovery, and processing states.
- Never hide the underlying operation's outcome, count, failure, or required action behind themed language.

## Domain Metaphors

| Domain | Visual metaphor | Working-state metaphor |
| --- | --- | --- |
| Knowledge | VS Code library book with a magical spark | Opening the collection |
| Skills | Spellbook | Opening the spellbook |
| Notes | Enchanted notebook | Opening the notebook |
| Research | Ancient scrolls | Consulting the scrolls |
| Tools | Wand | Preparing an incantation |
| Projects | Witch crossing a moon on a broom | Taking flight |
| Settings | Rune dials | Adjusting the instruments |
| Agents | House-elf | Summoning an assistant |
| Servers | Gateway to the Muggle world | Preparing the gateway |

## Motion Rules

- Animate only an active workspace, an explicit pending action, or visible progress.
- Prefer one recognizable motion per metaphor: page turn, wand cast, ink stroke, rising bubble, or traveling spark.
- Keep loops slow and quiet. Motion must not resize controls or move surrounding content.
- Honor `prefers-reduced-motion` by removing all decorative loops.
- Keep utility symbols such as Search, Refresh, Delete, arrows, and checkboxes as familiar Codicons.

## Icon Rules

- Domain icons use original rounded line art with a single clear silhouette at 16 px.
- Activity Bar artwork is monochrome and uses `currentColor`.
- Editor-tab and Marketplace artwork may use parchment gold, wand brown, sky blue, and deep ink navy.
- Decorative sparks are accents, not the primary silhouette.
- The extension brand mark combines a floating wand at upper-left, one independent star at upper-right, and a potion-filled cauldron below. The three objects do not touch.
- The Activity Bar mark is intentionally simpler: one rounded cauldron with three fine smoke wisps. It omits the wand, star, potion bottle, and flame so the silhouette remains clear at 24 px.
- Marketplace and editor-tab artwork is static. In extension-controlled loading surfaces, the same colored brand mark may animate only the rising steam and rolling potion bubbles; the cauldron, wand, and star remain stable.
- The Projects rail icon uses an original moonlit witch silhouette with one continuous curved hat, a visible head, cape, limbs, and broom. The rider floats gently while the cape moves; reduced-motion keeps the complete pose static.