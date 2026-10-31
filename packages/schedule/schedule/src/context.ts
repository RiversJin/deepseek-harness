/** Task-local retention of schedule inputs on the model-visible session surface. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from './activity.ts'
import type { ScheduleRecord } from './types.ts'
import { createDeveloperMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { TIME_PASSING_GUIDANCE } from './notification.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:schedule-context': { kind: 'plugin:schedule-context'; form: 'removed' | 'instructions' }
  }
}

/** Install request-time retention and optional time-passing guidance for one root agent.
 * @param agent - Task-owning agent.
 * @param guidance - Whether this deployment enabled the persistent explanation.
 * @param readTasks - Read current delivery policies from the owning service.
 * @returns Disposal of the exact registrations.
 */
export function registerScheduleContext(agent: Agent, guidance: boolean, readTasks: () => Promise<readonly ScheduleRecord[]>): () => void {
  const disposers: Array<() => void> = []
  let incoming = new Map<string, 'all' | 'latest'>()
  disposers.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (payload.agent !== agent || decision.kind === 'reject') return decision
    incoming = new Map(decision.messages.flatMap(message => {
      const source = message.source
      return source.kind === 'schedule' && source.taskId ? [[source.taskId, source.retain ?? 'all'] as const] : []
    }))
    const state = agent.ctx.sessionProjections.stateOf(agent.session, 'scheduleActivity')!
    if (guidance && !state.guidance.some(seq => agent.session.surface.nodes.some(node => node === seq))) {
      const message = createUserMessage({ content: [{ type: 'text', text: TIME_PASSING_GUIDANCE }],
        source: { kind: 'plugin:schedule-context', form: 'instructions' } })
      return { ...decision, messages: [message, ...decision.messages] }
    }
    return decision
  }))
  disposers.push(agent.ctx.on('agent/request', async ({ agent: owner, turn, step, signal }, next) => {
    const result = await next()
    if (owner !== agent || signal.aborted) return result
    const tasks = await readTasks()
    if (signal.aborted) return result
    const state = agent.ctx.sessionProjections.stateOf(agent.session, 'scheduleActivity')!
    const policies = new Map(state.retained.map(row => [row.taskId, row.retain]))
    for (const [id, retain] of incoming) policies.set(id, retain)
    for (const task of tasks) policies.set(task.id, task.retain ?? 'all')
    const retained = new Map(state.retained.map(row => [row.seq, row.taskId]))
    const seen = new Set([...incoming.keys()].filter(id => policies.get(id) === 'latest'))
    for (const seq of [...agent.session.surface.nodes].reverse()) {
      const id = retained.get(seq)
      if (id === undefined || policies.get(id) !== 'latest') continue
      if (!seen.has(id)) { seen.add(id); continue }
      agent.session.append('developer/message', { turn, step, message: createDeveloperMessage({
        content: [], source: { kind: 'plugin:schedule-context', form: 'removed' },
      }) }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    }
    incoming.clear()
    return result
  }))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}
