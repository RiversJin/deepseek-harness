import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId, Session, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { harness } from './harness.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const samples: Awaited<ReturnType<typeof harness>>[] = []
const roots: string[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T02:00:00Z')) })
afterEach(async () => { await Promise.all(samples.splice(0).map(sample => sample.ctx.fiber.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.useRealTimers() })
class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options)
    const last = options.messages.at(-1)
    if (last?.role === 'user' && last.source?.kind === 'schedule') {
      const id = ToolCallId(crypto.randomUUID())
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'fixture', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'fixture', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('runs ordinary tools, keeps the latest notification in requests and preserves both original deliveries in strict replay', async () => {
  const events: import('@deepseek-ai/dsh-session').SessionEvent[] = []
  const persistenceRoot = await mkdtemp(join(tmpdir(), 'schedule-idle-live-')); roots.push(persistenceRoot)
  const sample = await harness({
    persistenceRoot,
    config: { timePassingSessions: ['live-clock'] },
    beforeService: async ctx => {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.on('session/event', (_session, event) => { events.push(event) })
    },
  })
  samples.push(sample)
  const adapter = new Adapter()
  sample.ctx.llm.registerAdapter(['fixture'], adapter)
  let actions = 0
  sample.ctx.tools.register(defineContentToolFixture({ name: 'fixture', description: 'Read the fixture.', parameters: {},
    async execute() { actions++; return [{ type: 'text', text: 'Fixture read.' }] } }))
  const handle = await sample.ctx.agents.create({ sessionId: SessionId('live-clock'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  const agent = handle.agent
  sample.resolve.mockResolvedValue({ agent })
  const task = await sample.service.create(agent.session.id, { title: 'Time passing', prompt: '[Time passing]', idle_seconds: 60,
    active_window: { start: '10:00:00', end: '24:00:00', time_zone: 'Asia/Singapore' }, notification: 'time_passing', retain: 'latest' })
  await vi.advanceTimersByTimeAsync(60_001)
  await agent.whenIdle()
  await vi.advanceTimersByTimeAsync(60_001)
  await agent.whenIdle()
  expect(actions, JSON.stringify(events.filter(event => event.type === 'turn/end'))).toBe(2)
  const notices = (messages: GenerateOptions['messages']) => messages.filter(message => message.role === 'user' && message.source?.kind === 'schedule')
  expect(adapter.requests.map(request => notices(request.messages).length)).toEqual([1, 1, 1, 1])
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue with this conversation.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(notices(adapter.requests.at(-1)!.messages)).toHaveLength(1)
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'schedule')).toHaveLength(2)
  const history = await sample.service.history({ sessionId: agent.session.id, id: task.id, limit: 10 })
  expect('records' in history ? history.records : []).toHaveLength(2)
  const [latest] = await sample.service.list({ sessionId: agent.session.id })
  await sample.service.update({ sessionId: agent.session.id, id: task.id, expected: latest!, retain: 'all' })
  await vi.advanceTimersByTimeAsync(60_001); await agent.whenIdle()
  expect(notices(adapter.requests.at(-1)!.messages)).toHaveLength(2)
  const [all] = await sample.service.list({ sessionId: agent.session.id })
  await sample.service.update({ sessionId: agent.session.id, id: task.id, expected: all!, retain: 'latest' })
  await vi.advanceTimersByTimeAsync(60_001); await agent.whenIdle()
  expect(notices(adapter.requests.at(-1)!.messages)).toHaveLength(1)
  expect(actions).toBe(4)
  expect(JSON.stringify(adapter.requests).includes('Time-passing notifications are yours to configure.')).toBe(true)
  const header = { ...agent.session.header, delegationDepth: 0, isSeeded: false }
  const restore = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(header, 0), { recovery: 'strict', validation: 'current' })
  for (const event of events) restore.decodeRow(sessionFormatCatalog.encodeCurrentEvent(event as unknown as Parameters<typeof sessionFormatCatalog.encodeCurrentEvent>[0]))
  const restored = restore.finish()
  expect(restored.events.length).toBe(events.length)
  expect(Session.create(agent.session.id, restored.events as unknown as readonly SessionEvent[], header, SessionLogOffset(0)).deriveMessages()).toEqual(agent.session.deriveMessages())
  await handle.dispose()
})
