# Agent Note: A scheduler failure still pairs every recorded tool call

Status: implemented

English | [中文](2026-09-21-scheduler-failure-tool-results.zh.md)

## Problem

A model tool call is recorded twice in sequence: the assistant message carries the `tool_use` block, and the step appends a `tool/call` event. Recording the call without recording its result does not merely leave an unfinished step. A DeepSeek Messages request walks the log and rejects an assistant turn whose `tool_use` ids are not all resolved by the following user turn, and it does so while building the request, before any network call. One unmatched call therefore breaks every later turn in that session, whatever the model and connection are doing.

The agent loop's abort path already knew this. It answers every undispatched call with a synthetic `isError` result so the log stays a valid transcript. The scheduler-failure path did not: `startCall` appended the `tool/call`, then awaited `TOOL_RUNTIME_SCHEDULER.prepare`, and a throw from that call propagated through the group's failure `catch` without any result being written. Aborting and failing had different durable consequences for the same recorded call.

A collision between two `dsh-tools` module instances made that path reachable on every tool call in a source launch, but the gap was independent of it: any throw from scheduler-owned preparation, dispatch, or finalization reaches it. [How that collision was resolved](2026-09-21-workspace-package-entry-agreement.md) is a separate decision.

## Decision

The step closes out its recorded calls before a scheduler failure propagates. Two codes distinguish the situations, both under the error name `ToolSchedulerError` with the cause chain as model-facing text: `TOOL_SCHEDULER_FAILED` for a call that was recorded and may have reached its body, whose outcome is therefore unknown, and `TOOL_SCHEDULER_FAILED_BEFORE_DISPATCH` for a call the failure left unstarted.

Results are written by the existing ordered path, not at the point of failure. `startCall` already records its `tool/call` seq before awaiting preparation, and now latches a `prepare` throw instead of letting it escape unpaired. The group's failure `catch` drains in-flight dispatches, then commits whatever already settled through the same `commitReady` used on the ordinary path, so a dispatch that did produce a real outcome keeps it. Only then does it answer the remaining calls in model order. Writing a result at the moment of failure would have been simpler and wrong: results must commit in model order alongside siblings that already settled.

`executeToolCalls` also closes calls in groups the failure never reached. This is required for correctness rather than polish. The assistant message is appended once and names every call, so a later group's calls are exactly as unmatched as the failing group's.

The failure still reaches the turn boundary as the original error, so `turn/end` keeps `{ kind: 'error' }` with the original message instead of a synthesized tool error.

## Alternatives considered

**Augment the abort path instead of adding a failure path.** Abort is a different outcome with its own code and its own signal semantics; reporting a scheduler fault as `ABORTED_BEFORE_DISPATCH` would tell the model and the replay log that the user cancelled when the plugin failed.

**Append the synthetic result inside `startCall` at the throw site.** The obvious reading of the requirement, and it inverts result order as soon as a sibling in the same parallel pool settles first.

**Discard the group's already-settled results and synthesize for all of them.** Keeps the log valid but throws away completed tool work and reports success as failure.

**Repair the log on the next load.** Crash repair closes an *open* tail turn. A failure that already committed `turn/end` is not an open turn, so repair yields nothing; a session damaged this way before this change stays damaged.

## Consequences

A scheduler fault now costs one failed turn rather than the session. The durable log keeps one result per recorded call, so later turns can build a request from it and the model sees which calls ran.

The step can report tool outcomes it did not observe. `TOOL_SCHEDULER_FAILED` means exactly that: the call may have reached its body. The model-facing text carries the cause chain and does not claim the tool did not run.

Sessions already corrupted before this change are unaffected by it and must be replaced; the same `unmatched call` shape that crash repair closes was never reachable from an already-ended turn.

`packages/core/agent-loop/tests/tool-calls.spec.ts` holds three cases: a preparation throw inside a drained pool, a failure in a leading exclusive barrier whose later groups never ran, and a cap-limited group where only the first call was ever recorded. Together they cover both codes and both close-out paths. Each asserts that the error still propagates to `turn/end`, that every call the assistant message named is answered exactly once with no result for an unrecorded call, and that the derived history satisfies the provider rule that an assistant turn's tool calls are all resolved by the following user turn. No committed-session snapshot was added; the derived-history assertion covers the replay requirement for a path that is difficult to reproduce through a shipped profile.

The [cooperative tool cancellation decision](../architecture/2026-07-19-cooperative-tool-cancellation.md) still owns the abort codes and the registry boundary; this note owns only what a scheduler failure does with calls it already recorded.
