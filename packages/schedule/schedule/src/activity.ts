/** Durable session activity and task-specific delivery observations. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from './runtime.ts'

const stateSchema = z.object({
  lastEnd: z.number().nullable(),
  guidance: z.array(z.number()),
  lastHuman: z.number().nullable(),
  receipts: z.record(z.string(), z.object({ issuedAt: z.number(), messageId: z.string(), text: z.string(), scheduledAt: z.string().optional() })),
  retained: z.array(z.object({ seq: z.number(), taskId: z.string(), retain: z.enum(['all', 'latest']) })),
})
/** Log-derived activity shared by the timer and context retention. */
export type ScheduleActivityState = z.infer<typeof stateSchema>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { scheduleActivity: ScheduleActivityState }
}

/** Replayable task receipts, human-message clock, activity ends and visible retained inputs. */
export const scheduleActivityProjection: ProjectionDefinition<'scheduleActivity'> = {
  key: 'scheduleActivity', stateVersion: 1, stateSchema,
  init: () => ({ lastEnd: null, guidance: [], lastHuman: null, receipts: {}, retained: [] }),
  apply(previous, event) {
    let state = previous
    if (event.surfaceOp && typeof event.surfaceOp === 'object') {
      const { startSeq, endSeq } = event.surfaceOp
      state = { ...state, retained: state.retained.filter(row => row.seq < startSeq || row.seq > endSeq),
        guidance: state.guidance.filter(seq => seq < startSeq || seq > endSeq) }
    }
    if (event.type === 'user/message' && event.data.source.kind === 'plugin:schedule-context'
      && event.data.source.form === 'instructions') return { ...state, guidance: [event.seq] }
    if (event.type === 'turn/end') return { ...state, lastEnd: event.time }
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) {
        const source = message.source
        if (source.kind !== 'schedule' || !source.taskId || source.issuedAt === undefined) continue
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        state = { ...state, receipts: { ...state.receipts, [source.taskId]: { issuedAt: source.issuedAt, messageId: message.id, text, ...(source.scheduledAt === undefined ? {} : { scheduledAt: source.scheduledAt }) } } }
      }
    }
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') return state
    const source = event.data.source
    if (source.kind === 'user') return { ...state, lastHuman: event.time }
    if (source.kind === 'schedule' && source.taskId) {
      return { ...state, retained: [...state.retained, { seq: event.seq, taskId: source.taskId, retain: source.retain ?? 'all' }] }
    }
    return state
  },
}
