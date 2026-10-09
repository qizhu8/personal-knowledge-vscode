# Retrieval Click Evaluation

Status: design only. No click collector, online training, external transmission
or embedding-weight update is enabled by this proposal.

## Signals And Limits

A click is evidence that a displayed item attracted attention, not proof of
relevance or a correct answer. An unclicked item may not have been visible,
may have been unnecessary after another result, or may have been missed.
Never label unclicked items as negative training examples automatically.

Assign a random impression ID to each completed search result presentation.
Associate result events with that ID, the retrieval route/configuration,
corpus revision, displayed rank and whether the result entered the visible
viewport. Record selection/open separately from successful content loading.
Deduplicate repeated opens within the impression. An optional bounded active
dwell bucket is descriptive only; background-tab time is not reading time.

Explicit user judgments such as relevant, not relevant or useful to this task
are distinct events and are the strongest available supervision. Closing the
search, navigating away and opening nothing are censored or abandonment
observations, not blanket negative labels. Cancelled/failed/stale requests
must not generate a completed impression. Empty results remain measurable.

## Consent And Privacy

Collection is disabled by default and requires separate informed opt-in.
Using search, Allow All or joining a subscription does not imply consent.
The setting must disclose fields, local storage, retention and permitted use,
and offer view, export, delete and immediate disable controls. Disabling stops
new events; deletion removes stored events and associated identity salts.

Default events contain no raw query, task text, document title/body, file path,
account identity, URL, token or diagnostic content. Query IDs are random,
not hashes of query text. Result identities use a local salted HMAC with a
rotation boundary; an unsalted hash is not anonymization. Do not emit private
versus public item identifiers outside the local collector. Hashes remain
pseudonymous data and require retention/access controls.

Use a separate bounded local store, for example under the existing PKM state
directory, with a 30-day default retention and a size/event limit. Do not
append these events to synced knowledge or the query-free search outcome
collector. Export is explicit and previews the fields; external upload needs
separate consent. Any future opt-in query/content capture requires a different
disclosure and redaction policy, not an invisible expansion of this schema.

## Evaluation

Report exposure-conditioned open rate, Open@K, distinct opens, zero-result rate,
load failures and latency as interaction metrics. Show sample sizes and route,
corpus and configuration revisions. Do not relabel click rate as Precision@K.
Compute Precision@K, Recall@K, NDCG@K and answer usefulness only against an
explicitly judged corpus with a documented denominator and missing judgments.

Rank affects exposure and clicks. Compare the same eligible population and
visible exposure before comparing routes. Any randomized exploration or
propensity correction needs explicit approval, documented assignment and
valid exposure probabilities. Do not invent those probabilities from logs.
Separate repeat users/sessions and temporal changes; prevent private-corpus
and test-set leakage between training and evaluation partitions.

Start with an offline, versioned, judged set and immutable route baselines.
Only after adequate consented samples and predefined guardrails should a
small randomized A/B evaluation be considered. Monitor latency, zero-results,
privacy violations and explicit negative feedback alongside positive opens.
An inconclusive small sample is not grounds for deploying a new ranker.

## Training Boundary

Convert explicit judgments into versioned examples with provenance and a
review/removal process. Click-only observations can support hypotheses or
review queues, not automatic hard labels. Apply position/exposure correction
only when its assumptions are met. Keep a held-out judged set and prevent
evaluation impressions from becoming training examples for the same model.

Train or calibrate a retrieval/ranking component offline, not embedding-model
weights implicitly. A candidate must improve judged quality without violating
latency/privacy guardrails, pass a reviewed release gate and remain reversible.
The currently disabled model/parameter map stays disabled until a real engine
and these gates exist.

## Implementation Acceptance

- No events before consent; disable/delete/export work locally and after restart.
- Failed, stale and cancelled searches cannot fabricate impressions.
- Events distinguish displayed, exposed, opened, loaded and explicitly judged.
- Private raw text/paths and secret-like values never enter the default schema.
- Scroll, repeated opens, empty results and background tabs have deterministic tests.
- Counts and retention are bounded; clearing data also clears linkable salts.
- Click-only reports cannot claim correctness or automatically create negatives.
- No automatic Sync, external upload, parameter training or model-weight update.