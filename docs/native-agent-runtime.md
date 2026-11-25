# Canonical native Agent runtime

With an explicitly configured native Agent host, task policy and current
actor-to-owner binding, Core exposes `agent.runtime.spawn`, `cancel`, `get`,
`list`, `restore` and `reconnect`. Without that integration these operations
remain unavailable. Mutation calls require the current actor's write authority;
public arguments cannot select an actor, owner token, prompt or permission grant.

`restore` accepts only the exact ID and digest of an owner-bound, host-pinned
`pkm.agent.runtime.synthetic-snapshot/v1` tree. It creates new sessions using
configured native tasks and their existing child-capability narrowing. This is
not historical Agent SDK, transcript, credential, checkpoint or paused-workflow
restoration, and does not inherit archived grants or authorize automatic
execution of historical work.

`reconnect` requires an owned session and its exact revision. It reconciles the
existing native handle; a `spawn-unknown` observation never authorizes another
spawn. Native ownership is rechecked around host calls, including changes during
inspection. Repeated public mutation IDs must match the original actor,
operation and arguments; their durable receipts do not replay host effects.
The native workspace lease and shared receipt transaction remain authoritative.
