/** The scheduler key must be shared across module copies, not private to one module evaluation. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER, type ToolRuntimeScheduler } from '@deepseek-ai/dsh-tools'

const SHARED_KEY = '@deepseek-ai/dsh-tools.scheduler'

describe('TOOL_RUNTIME_SCHEDULER', () => {
  it('resolves through the global symbol registry so a second module copy agrees on the scheduler key', async () => {
    expect(TOOL_RUNTIME_SCHEDULER).toBe(Symbol.for(SHARED_KEY))

    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)

    // dsh-agent-loop reaches the scheduler through its own copy's constant, so
    // only a registry key makes that lookup land on this instance.
    const scheduler = Reflect.get(ctx.tools, Symbol.for(SHARED_KEY)) as ToolRuntimeScheduler | undefined
    expect(scheduler).toBeDefined()
  })
})
