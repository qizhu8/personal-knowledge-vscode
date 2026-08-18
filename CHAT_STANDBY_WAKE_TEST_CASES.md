# Chat Standby Wake Test Cases

A message wakes an Agent when the Hub's validated structured `recipients` contains that participant (or `all`/`everyone`). Text parsing is only a legacy fallback.

| ID | Message / frame | Target state | Expected standby result |
|---|---|---|---|
| W01 | Leading `@Target`, recipients=[Target], required | standby | Wake; `reply_required=true` |
| W02 | Middle `@Target`, recipients=[Target], required | standby | Wake; `reply_required=true` |
| W03 | Trailing `@Target`, recipients=[Target], required | standby | Wake; `reply_required=true` |
| W04 | Markdown table then trailing `@Target`, recipients=[Target] | standby | Wake |
| W05 | recipients=[Target], body contains no mention | standby | Wake; structured routing is authoritative |
| W06 | Body mentions Target, recipients excludes Target | standby | Do not wake; validated frame is authoritative |
| W07 | Unknown `@word`, recipients=[] | standby | Do not wake |
| W08 | recipients=[Other] | standby | Do not wake Target |
| W09 | recipients=[all], Host sender | standby | Wake Target |
| W10 | recipients=[everyone], Host sender | standby | Wake Target |
| W11 | recipients=[Target], policy=none | standby | Wake to observe; `reply_required=false` |
| W12 | recipients=[Target], policy=optional | standby | Wake; optional substantive response |
| W13 | recipients=[Target], message from self | standby | Do not wake self |
| W14 | Multiple queued targeted messages | standby | Wake once with bounded batch and all event IDs |
| W15 | Legacy leading mention, no recipients field | standby | Wake via text fallback |
| W16 | Legacy middle mention, no recipients field | standby | Hub must populate recipients before relay; direct bridge fallback need not infer middle text |
| W17 | `/stop` lifecycle | standby | Wake terminal; do not continue standby |
| W18 | Room close | standby | Wake terminal |
| W19 | Transport terminal error | standby | Wake with retry metadata |
| W20 | No targeted event before diagnostic timeout | standby | Internal heartbeat behavior per standby contract; no false message wake |
| W21 | Middle `@"Agent With Spaces"`, recipients=[Agent With Spaces] | standby | Wake exact spaced alias |
| W22 | recipients casing differs from alias | standby | Wake case-insensitively |
| W23 | Target is `Agent With`; recipients=[Agent With Spaces] | standby | Do not wake similar prefix |
| W24 | Unquoted `@Agent With Spaces` with no matching `Agent` alias | standby | Do not infer full spaced alias |

## Invariants

1. `recipients` is authoritative whenever present, including an explicit empty list.
2. The Agent must never re-derive modern routing from arbitrary body text.
3. `reply_policy` controls response obligation, not whether a recipient observes the message.
4. Self-authored messages never wake the same Agent.
5. Async generated MCP and checked-in synchronous bridge must pass the same wake cases.
