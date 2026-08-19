# Chat Composer Recipient Test Cases

The `To` row is a token editor. Message text and routing recipients are separate fields.

| ID | Initial To source | User action | Expected To | Expected body |
|---|---|---|---|---|
| R01 | No previous message | Type plain text as Host | `@all` | Unchanged |
| R02 | Previous To: A, B | Type plain text | A, B | Unchanged |
| R03 | Previous To: A, B | Type `@C` in middle | A, B, C | `@C` remains |
| R04 | Previous To: A, B | Delete middle `@C` | A, B | Remaining text unchanged |
| R05 | Previous To: A, B | Type leading `@C ` | A, B, C | Leading `@C ` removed |
| R06 | Previous To: A, B | Type leading `@C @D ` | A, B, C, D | Both leading mentions removed |
| R07 | Previous To: A, B | Remove inherited B chip | A | Body unchanged |
| R08 | Previous To: `@all` | Remove `@all` chip | Empty | Body unchanged |
| R09 | Empty edited To | Type middle `@A` | A | `@A` remains |
| R10 | Manual A | Type middle `@B` | A, B | `@B` remains |
| R11 | A is inherited and mentioned | Delete body `@A` | A | Mention removed; inherited A remains |
| R12 | A is mention-only | Delete body `@A` | Empty | Mention removed |
| R13 | A manually removed | Body still contains `@A` | Empty | `@A` remains; explicit chip removal wins for draft |
| R14 | Present roster A, B, C | Host selects A, B, C | `@all` | Unchanged |
| R15 | Present roster A, B, C | Host removes body `@C` | A, B | Remaining body unchanged |
| R16 | Present roster A, B | Non-Host selects A, B | A, B | Never normalize to `@all` |
| R17 | Previous To includes departed D | Start new draft | Present recipients only | Unchanged |
| R18 | To input focused | Type `@` + choose A | Add A token | Body unchanged |
| R19 | To input focused | Left/Right | Move selected token | Body unchanged |
| R20 | Token selected | Backspace/Delete | Remove selected token | Body unchanged |
| R21 | No token selected, empty To input | Backspace | Select/remove last token | Body unchanged |
| R22 | Body starts with Markdown heading/table/fence | Send | Structured To only | Body first character unchanged |
| R23 | Send draft | Successful send | Reset manual/removed/selection state | Next draft inherits sent To |
| R24 | Duplicate mentions/manual token | Recompute | One token per participant | Body unchanged |
| R25 | Unknown `@word` | Type/delete | No token | Body unchanged |
| R26 | Host mentions all roster members except self, including offline members | Recompute | Single `@all` token | Body unchanged except leading mentions moved |
| R27 | Present alias `Agent With Spaces` | Type leading `@"Agent With Spaces" ` | Add exact token | Leading quoted mention removed |
| R28 | Present alias `Agent With Spaces` | Type middle `@"Agent With Spaces"` | Add exact token | Mention remains |
| R29 | Present alias `Agent With Spaces`, no alias `Agent` | Type unquoted `@Agent With Spaces` | Do not add a token | Body remains literal |
| R30 | Present aliases with similar prefixes | Select one exact alias | Add only exact token | Body unchanged |
| R31 | Present alias `LP Extractor Dev` | Insert complete `@"LP Extractor Dev"` with autocomplete, then backspace its closing quote | Add after complete insertion, remove as soon as the quote is broken | Follow each authored edit |
| R32 | Present alias `Amy` | Type `@Amy` or `@"Amy"` | Add exact `Amy` token for either form | Body remains literal |
| R33 | Offline alias remains in roster | Select or type its valid mention | Add exact offline token | Body follows normal quoted/unquoted rules |

## Invariants

1. `To` token source is the union of inherited, manual, and current-body mentions minus explicitly removed recipients.
2. Leading mentions are routing syntax and move from body to `To`; non-leading mentions remain authored text.
3. A complete Host audience normalizes to `@all`; non-Host audiences never do.
4. Every roster alias, including offline participants, and Host-reserved `@all` are valid tokens.
5. Sending never prefixes recipient text into Markdown body.
6. Keyboard token editing never changes the message body.
