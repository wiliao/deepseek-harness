# Agent Note: One module instance per workspace package under a source launch

Status: implemented

English | [中文](2026-09-21-workspace-package-entry-agreement.zh.md)

## Problem

Launching from source (`pnpm dsh`, that is `node --import tsx/esm apps/cli/src/bin.ts`) loaded two module instances of `@deepseek-ai/dsh-tools` in one process: 27 import sites resolved to `packages/core/tools/src/index.ts` through the tsconfig `paths` projection, and one resolved to `packages/core/tools/lib/index.js`.

That one site was the Loader's own entry import. `Include.import` (`vendor/loader/src/config/tree.ts`) resolves a bare plugin name with `ctx.baseUrl` as the parent, and `ctx.baseUrl` is the profile directory. The profile resolution router caught that request, matched a fallback route, and re-resolved from the route's declarer manifest inside `apps/cli/node_modules` — an import chain with no source file in it, where the `paths` projection does not apply and the package manifest's published entry wins.

The consequence was a hard failure rather than a subjective ambiguity. `TOOL_RUNTIME_SCHEDULER` was then `Symbol('@deepseek-ai/dsh-tools.scheduler')`, a fresh symbol per module evaluation, so the `agent-loop` copy never matched the `ToolRuntime` instance's key and every tool call died with `Cannot read properties of undefined (reading 'prepare')`. The failed step had already recorded a `tool/call` and never recorded its result; a DeepSeek Messages request rejects an assistant turn whose `tool_use` ids are not all resolved by the following user turn, so the session failed every later turn too. The built launch loaded one plane and could not observe the defect.

## Decision

A fallback route selects the **package**, not the entry inside it. When the importer's own lookup order resolves a request into the package directory the route selected, the router returns that resolution; only when the importer cannot reach the package at all does it re-resolve from the declarer manifest. The comparison is canonical, because the intervening `node_modules` paths are symlinks.

The rule is scoped to `enforce` behavior, the mode every real launch uses (`resolutionMode: 'runtime'`, the launcher default). Dual mode keeps comparing Node's disk result against the generation, because what it verifies is package identity rather than entry selection.

The router does not detect a source launch. It never inspects process arguments or probes for `tsx`; it asks the loader a question the loader answers — whether the importer's own order resolves into the selected package directory. A packaged executable, whose importer has no such path, keeps the previous route unchanged. The importer's chain reaches a workspace package through the active loader hooks rather than through the fallback table, since a launch that never materialized the profile links leaves the importer no lookup path of its own.

## Alternatives considered

**Detect the source launch and skip routing.** Reachable through process arguments or a `tsx` resolution probe, but it makes runtime behavior depend on how the process was started and leaves the underlying ambiguity — two entries for one package — in place for every other launch vector.

**Compare package directories with `createRequire`.** This reads the profile `node_modules` fallback links, which ordinary launches never materialize, so the check would pass in a fixture that creates links and fail in production. The URL-containment comparison depends only on the loader hooks that produce the divergence.

**Share the scheduler symbol through `Symbol.for` instead.** The cheapest way to stop the crash, and it remains useful as independent hardening, but it converts a hard failure into two live `ToolRuntime` instances — two registries and two caches — so it addresses the symptom rather than the duplicated module.

**Let the generation select the entry as well as the package.** A deployment could then pin a workspace package to its built entry, but the generation is computed before any plugin loads and knows nothing about the active loader hooks; encoding their effect would duplicate resolution outside the resolver Node consults.

## Consequences

A source launch loads one instance of every workspace package: `packages/*/lib/` loads fall from 62 to 7, and the 7 remaining are generated `typert.host.js` artifacts rather than duplicates of a `src` module. `pnpm dsh` works without the built launch, and the failure that poisoned sessions disappears at its source.

The rule narrows what a fallback route controls. The generation still chooses which package, but the loader hooks choose which entry inside it. A deployment whose hooks map a workspace package to a file outside that package's directory keeps the previous behavior, because directory agreement is required; a package that relies on the generation to override the entry for a package the importer can also reach is no longer overridable in enforce mode. No such route exists in this repository, where every observed divergence was `src` versus `lib` within one package.

`packages/boot/app-boot/tests/profile-resolution.spec.ts` covers the rule with a registered loader hook, including the case where the importer cannot reach the selected package and the generation route must stand. That hook cannot be removed once registered, so it owns a package name no other case uses. A packaged-executable run remains unmeasured; the rule cannot change that path because a packaged binary has no source-plane hook, but that argument is reasoning rather than evidence.

The same defect left a second, independent gap: a scheduler failure recorded no result for a call it had already logged, which is what made one crash poison a session permanently. The paired-result decision for scheduler failures is recorded separately.
