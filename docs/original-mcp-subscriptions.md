# Current native Subscription reads

The original public `list_subscriptions`, `search_subscribed_content`,
`get_subscribed_content`, and `get_subscribed_content_by_path` routes use a
separate bounded current-source bridge. They never read a legacy cache tree.
Client-side membership and corpus validators use the shared thin error leaf,
not the broad Core contract graph; shipped builds retain the active-host/retained-module bundle guard.

The delivered native attachment advertises `subscription.profile.current` and
`subscription.read.approve`. The same-owner native bootstrap automatically
composes `createOriginalMcpCurrentSubscriptionSource(storage, session)` with those
methods: no embedding callback, inherited account grant, or legacy-adoption
marker is required. Missing methods remain unavailable rather than falling back.

The producer reads only `native-subscriptions/current.json` in its independently
pinned v5 globalStorage directory and the explicitly pinned files below
`native-subscriptions/cache/`. An absent current file creates a read-only empty
subscriber state from the current native **public** identity. This still requires
source-specific native enrollment consent and per-call read consent. It never
imports a signing key, old `subscriptions.json`, private history, or legacy cache.

A configured current source uses `pkm.original-native-subscription-profile/v1`:
exact root/workspace/profile/native-identity binding, UUID `sourceEpoch`,
nonnegative monotonically advancing `revision`, public subscriber `state`, and
`files` containing cache-relative path/SHA-256/byte-size pins. State contains no
private key or publisher shares. Broker cache pins include signed `summary.json`,
`_subscription.json`, `bundle.json`, materialized content and its provenance.
The producer validates the provider's signed membership/summary, downloaded
bundle hash, and exact original materializer projection before enrolling bytes.
Protected sources additionally pin `bundle.encrypted.json`, the downloaded
snapshot envelope after transport decryption. The native producer uses only the
current member's opaque protected key to verify its authenticated decryption and
match the plaintext bundle; key values never cross IPC or enter receipts.
GitHub source identity/target/current commit metadata and current opaque
credential presence retain their existing bounded checks.

The current original-owned source domain uses immutable
`native.subscription.original-profile.admit` entries in the existing `receipts`
table. Admission binds the signed current session, source consent, manifest head,
and every public file byte. Same-revision changed sources and older admitted
revisions are refused; previous receipts are never reset or reconstructed.
Only bounded metadata of this new domain is examined, with at most 4096
admissions; unknown/corrupt domain records require reconciliation.

`createOriginalMcpSubscriptionSource` remains available for genuinely
legacy-adopted native profiles and their unchanged historical verification.
That separate domain cannot manufacture original-root custody, and the default
original bootstrap does not pretend its Root was legacy-adopted.

Each call requires fresh exact signed native consent binding actor, root, profile,
epoch, membership, publisher key/provider, revision, collection hash, pinned corpus
and arguments. Consent expires within five minutes. Revocation closes the signed
attachment. The bridge checks the current source before and after projection,
validates metadata identity and source hashes, and excludes assets and provenance
sidecars from content search. Provenance is an allowlisted public projection.

Limits are 100 members/results, 128 pinned files, 2 MiB per file, 8 MiB per
snapshot, and 2048-character queries. Oversized projections fail closed; this
original protocol has no paging cursor. Canonical subscription paging and
`subscription.broker.share-markers` retain their existing implementation.
Before loading immutable profile bytes, the producer checks aggregate file/body
sizes across the validated lineage. Oversized lineage is refused rather than
reading unbounded old generations or weakening their receipt verification.

No DDL, existing durable record versions, historical admissions or migration
rules change. Local qualification exercises real original custody, actual signed
native IPC, the delivered profile producer, default bootstrap composition,
immutable source enrollment, all four public reads, and protected corpus
verification. Live external Broker/GitHub account acceptance and the final
combined installed package remain separate qualifications.
