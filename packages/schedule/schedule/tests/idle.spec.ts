import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ScheduleId, decodeScheduleRecord } from '../src/domain.ts'
import { afterActivity, createIdleScheduleRecord, nextInWindow } from '../src/idle.ts'
import { resolveScheduleUpdate } from '../src/update.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import type { ScheduleTask } from '../src/storage.ts'
import { harness, agentFor } from './harness.ts'

const window = { start: '10:00:00', end: '24:00:00', time_zone: 'Asia/Singapore' }
const samples: Awaited<ReturnType<typeof harness>>[] = []
const runtimes: ScheduleRuntime[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T01:00:00Z')) })
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  await Promise.all(samples.splice(0).map(sample => sample.ctx.fiber.dispose()))
  vi.useRealTimers()
})
function record() {
  return afterActivity({ ...createIdleScheduleRecord(ScheduleId('clock'), '[Time passing]', 1800, Date.now(), 'Time passing'),
    activeWindow: window, notification: 'time_passing' as const, retain: 'latest' as const }, Date.now())
}
async function setup(row = record()) {
  const sample = await harness(); samples.push(sample)
  const agent = agentFor(sample.ctx)
  sample.resolve.mockResolvedValue({ agent })
  const tasks: ScheduleTask[] = [{ sessionId: SessionId('original'), record: row, status: 'active' }]
  const runtime = new ScheduleRuntime(sample.ctx, () => tasks, work => work(), async task => { tasks[0] = task }, { days: 30, records: 200 })
  runtimes.push(runtime)
  runtime.requestDrive()
  return { ...sample, tasks, runtime, agent }
}

it('retains quiet duration, local delivery hours and latest-context choices through durable decoding', () => {
  const saved = record()
  expect(decodeScheduleRecord(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  expect(saved.scheduledAt).toBe('2026-10-16T02:00:00.000Z')
})

it('opens at ten for an already completed quiet interval and keeps the remaining quiet time otherwise', () => {
  const saved = record()
  expect(afterActivity(saved, Date.parse('2026-10-16T01:20:00Z')).scheduledAt).toBe('2026-10-16T02:00:00.000Z')
  expect(afterActivity(saved, Date.parse('2026-10-16T01:50:00Z')).scheduledAt).toBe('2026-10-16T02:20:00.000Z')
  expect(afterActivity(saved, Date.parse('2026-10-16T15:50:00Z')).scheduledAt).toBe('2026-10-17T02:00:00.000Z')
})

it('preserves local-window behavior across a timezone offset transition and overnight hours', () => {
  const paris = { start: '10:00:00', end: '24:00:00', time_zone: 'Europe/Paris' }
  expect(new Date(nextInWindow(Date.parse('2026-03-29T01:30:00Z'), paris)).toISOString()).toBe('2026-03-29T08:00:00.000Z')
  const overnight = { start: '22:00:00', end: '06:00:00', time_zone: 'Asia/Singapore' }
  expect(new Date(nextInWindow(Date.parse('2026-10-16T00:00:00Z'), overnight)).toISOString()).toBe('2026-10-16T14:00:00.000Z')
})

it('edits the interval against the existing activity anchor and retains independent delivery choices', () => {
  const saved = record()
  const result = resolveScheduleUpdate(saved, saved, { kind: 'idle', idle_seconds: 5400 }, Date.now() + 600_000)
  expect(result).toMatchObject({ updated: true, record: { ...saved, idleSeconds: 5400, scheduledAt: '2026-10-16T02:30:00.000Z' } })
})

it('delivers at ten and stores the actual dynamic body in delivery history', async () => {
  const sample = await setup()
  await vi.advanceTimersByTimeAsync(3600_000)
  expect(sample.agent.followup).toHaveBeenCalledTimes(1)
  const message = sample.agent.followup.mock.calls[0]![0]
  expect(message.content).toEqual([{ type: 'text', text: '[Time passing]\nCurrent time: 2026-10-16 10:00:00 (Asia/Singapore)\nTime spent quiet: 1h 0s' }])
  expect(sample.tasks[0]?.deliveryHistory?.records[0]?.prompt).toBe(message.content[0]?.type === 'text' ? message.content[0].text : '')
  expect(sample.tasks[0]?.record.scheduledAt).toBe('2026-10-16T02:30:00.000Z')
})

it('starts the next quiet interval when ongoing activity completes', async () => {
  const sample = await setup()
  const activity = Promise.withResolvers<void>()
  Object.defineProperty(sample.agent, 'status', { configurable: true, value: 'running' })
  sample.agent.whenIdle = () => activity.promise
  sample.ctx.emit('agent/status', { agent: sample.agent, status: 'running' })
  await vi.advanceTimersByTimeAsync(7200_000)
  Object.defineProperty(sample.agent, 'status', { configurable: true, value: 'idle' })
  activity.resolve()
  await vi.advanceTimersByTimeAsync(1800_000)
  expect(sample.agent.followup).toHaveBeenCalledTimes(1)
  expect(sample.tasks[0]?.record).toMatchObject({ quietSince: '2026-10-16T03:30:00.000Z', scheduledAt: '2026-10-16T04:00:00.000Z' })
  expect(sample.agent.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: '[Time passing]\nCurrent time: 2026-10-16 11:30:00 (Asia/Singapore)\nTime spent quiet: 30m 0s' }])
})

it('persists the same task identity and edits across service restoration', async () => {
  const first = await harness(); samples.push(first)
  const created = await first.service.create(SessionId('persisted'), { title: 'Time passing', prompt: '[Time passing]',
    idle_seconds: 1800, active_window: window, notification: 'time_passing', retain: 'latest' })
  await first.service.update({ sessionId: SessionId('persisted'), id: created.id, expected: created, change: { kind: 'idle', idle_seconds: 2700 } })
  const before = await first.service.list({ sessionId: SessionId('persisted') })
  await first.fiber.dispose()
  const second = await harness({ pool: first.pool }); samples.push(second)
  expect(await second.service.list({ sessionId: SessionId('persisted') })).toEqual(before)
  await second.service.delete({ sessionId: SessionId('persisted'), id: created.id })
  expect(await second.service.catalog()).toEqual([])
})
