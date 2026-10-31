/** Host timer over stored tasks; Session activation is a delivery operation. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule'; taskId?: string; notification?: 'prompt' | 'time_passing'; retain?: 'all' | 'latest'; issuedAt?: number; quietSince?: number; scheduledAt?: string } & ContextFormed
  }
}
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { isRecurringScheduleRecord, renderReminderFraming, renderRecurringReminderBatchFraming, resolveRecurringOccurrence } from './domain.ts'
import type { DeliveryRetentionBounds, RecurringScheduleRecord } from './types.ts'
import type { ScheduleTask } from './storage.ts'
import { appendDelivery } from './delivery-history.ts'
import { afterActivity, nextInWindow } from './idle.ts'
import { timeNotification } from './notification.ts'
import type {} from './activity.ts'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Owns at most one timer across recomputations; delivery and management share the serialized operation. */
export class ScheduleRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopping = false
  private requested = false
  private readonly activityEnds = new Map<string, number>()
  private readonly waiting = new Set<string>()
  private readonly disposeListeners: Array<() => void> = []

  /**
   * @param ctx - Host services used to resume and enqueue.
   * @param tasks - Current durable tasks.
   * @param transact - Serialize delivery against management writes.
   * @param commit - Persist task status, target, receipt, and history together after durable inbox delivery.
   */
  constructor(
    private readonly ctx: Context,
    private readonly tasks: () => readonly ScheduleTask[],
    private readonly transact: (work: () => Promise<void>) => Promise<void>,
    private readonly commit: (task: ScheduleTask) => Promise<void>,
    private readonly retention: DeliveryRetentionBounds,
  ) {
    this.disposeListeners.push(ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end' && event.type !== 'turn/start') return
      if (!this.tasks().some(task => task.sessionId === session.id && task.status === 'active' && task.record.kind === 'idle')) return
      if (event.type === 'turn/end') this.activityEnds.set(session.id, event.time)
      this.requestDrive()
    }, { global: true }))
    this.disposeListeners.push(ctx.on('agent/status', ({ agent, status }) => {
      if (!this.tasks().some(task => task.sessionId === agent.session.id && task.status === 'active' && task.record.kind === 'idle')) return
      if (status === 'running') this.waitForActivity(agent)
      this.requestDrive()
    }))
  }

  /**
   * Recompute the nearest obligation after startup or a durable change.
   * Dispatch failures are logged; refused admission does not retry automatically.
   */
  requestDrive(): void {
    if (this.stopping) return
    this.requested = true
    this.clearTimer()
    if (this.running !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(async () => {
        while (this.requested && !this.stopping) {
          this.requested = false
          await this.transact(async () => { await this.drive() })
        }
      })
    } catch (error: unknown) {
      // Ancestor unloading closes initiator admission before runtime cleanup runs.
      this.requested = false
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
      return
    }
    this.running = run
    void run.catch((error: unknown) => {
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
    }).finally(() => {
      this.running = undefined
      if (this.requested && !this.stopping) this.requestDrive()
    })
  }

  /** Stop the timer and drain an accepted delivery before storage closes. */
  async dispose(): Promise<void> {
    this.stopping = true
    for (const dispose of this.disposeListeners) dispose()
    this.clearTimer()
    // requestDrive reports execution failures; teardown only waits for quiescence.
    await this.running?.catch(() => undefined)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private waitForActivity(agent: Agent): void {
    const id = agent.session.id
    if (this.waiting.has(id)) return
    this.waiting.add(id)
    void agent.whenIdle().then(() => {
      if (this.stopping) return
      this.activityEnds.set(id, Date.now())
      this.waiting.delete(id)
      this.requestDrive()
    }).catch((error: unknown) => {
      this.waiting.delete(id)
      if (!this.stopping) this.ctx.logger.warn(`schedule: activity observation failed: ${String(error)}`)
    })
  }

  private target(task: ScheduleTask, now: number): number {
    if (task.record.kind === 'idle' && this.waiting.has(task.sessionId)) return Infinity
    return nextInWindow(Math.max(Date.parse(task.record.scheduledAt), now), task.record.activeWindow)
  }

  private async deliverIndividual(task: ScheduleTask, agent: Agent): Promise<void> {
    const idle = task.record.kind === 'idle'
    if (idle && agent.status === 'running') { this.waitForActivity(agent); return }
    const publish = async (signal: AbortSignal): Promise<void> => {
      if (this.stopping || signal.aborted) return
      const activity = this.ctx.sessionProjections.stateOf(agent.session, 'scheduleActivity')!
      const latest = activity.receipts[task.record.id]
      let record = task.record
      if (record.kind === 'idle' && activity.lastEnd !== null && activity.lastEnd > Date.parse(record.quietSince)) {
        record = afterActivity(record, activity.lastEnd)
      }
      const recovered = latest && latest.messageId !== task.lastDelivery?.messageId ? latest : undefined
      const now = recovered?.issuedAt ?? Date.now()
      if (!recovered && this.target({ ...task, record }, now) > now) {
        if (record !== task.record) await this.commit({ ...task, record })
        return
      }
      if (idle && !recovered && agent.inbox.nextTurn.length > 0) {
        this.waitForActivity(agent)
        return
      }
      const previous = task.lastDelivery === undefined ? undefined : Date.parse(task.lastDelivery.deliveredAt)
      const quietSince = record.kind === 'idle' ? Date.parse(record.quietSince) : activity.lastEnd ?? now
      const text = recovered ? recovered.text
        : record.notification === 'time_passing'
          ? timeNotification(now, quietSince, previous, activity.lastHuman ?? undefined, record.activeWindow?.time_zone ?? 'UTC')
          : record.prompt
      const message = createUserMessage({ content: [{ type: 'text', text }], source: {
        kind: 'schedule', taskId: record.id, notification: record.notification ?? 'prompt', retain: record.retain ?? 'all',
        issuedAt: now, quietSince, scheduledAt: record.scheduledAt,
      } })
      signal.throwIfAborted()
      if (!recovered) agent.followup(message)
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Session persistence did not acknowledge the reminder')
      const occurrence = isRecurringScheduleRecord(record) ? resolveRecurringOccurrence(record, now) : undefined
      const next = record.kind === 'idle' ? afterActivity(record, Math.max(now, activity.lastEnd ?? 0))
        : occurrence ? { ...record, scheduledAt: occurrence.nextScheduledAt ?? occurrence.occurrenceAt } : record
      await this.commit({ ...task, record: next,
        status: record.kind === 'idle' || occurrence?.nextScheduledAt !== undefined ? 'active' : 'inactive',
        ...appendDelivery({ ...task, record: { ...record, prompt: text } }, {
          scheduledAt: recovered?.scheduledAt ?? occurrence?.occurrenceAt ?? record.scheduledAt, deliveredAt: new Date(now).toISOString(), messageId: recovered ? MessageId(recovered.messageId) : message.id,
        }, this.retention) })
      if (recovered) this.requestDrive()
    }
    if (!idle) { await publish(new AbortController().signal); return }
    let work: Promise<void>
    try { work = agent.runMaintenance(publish) }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already has active work')) throw error
      this.waitForActivity(agent)
      return
    }
    await work
  }

  private async drive(): Promise<void> {
    this.clearTimer()
    const failed = new Set<string>()
    const handled = new Set<string>()
    const scanNow = Date.now()
    for (const task of this.tasks()) {
      const endedAt = this.activityEnds.get(task.sessionId)
      if (task.status === 'active' && task.record.kind === 'idle' && endedAt !== undefined && endedAt > Date.parse(task.record.quietSince)) {
        await this.commit({ ...task, record: afterActivity(task.record, endedAt) })
      }
    }
    const due = this.tasks().filter(task => task.status === 'active' && this.target(task, scanNow) <= scanNow)
    for (const task of due) {
      if (this.stopping) return
      if (handled.has(task.record.id)) continue
      if (task.record.kind === 'idle' || task.record.notification !== undefined || task.record.retain !== undefined) {
        handled.add(task.record.id)
        try {
          const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId)
          if ('error' in resolved) throw resolved.error
          if (!this.stopping) await this.deliverIndividual(task, resolved.agent)
        } catch (error) {
          failed.add(task.record.id)
          this.ctx.logger.warn(`schedule: reminder ${task.record.id} was not acknowledged: ${String(error)}`)
        }
        continue
      }
      const group = isRecurringScheduleRecord(task.record)
        ? due.filter(candidate => candidate.sessionId === task.sessionId && isRecurringScheduleRecord(candidate.record)
          && candidate.record.notification === undefined && candidate.record.retain === undefined)
        : [task]
      for (const member of group) handled.add(member.record.id)
      let admitted = group
      const committed = new Set<ScheduleTask['record']['id']>()
      try {
        const resolved = await this.ctx.sessionController.resolveAgent(task.sessionId)
        if ('error' in resolved) throw resolved.error
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Disposal can run while Session restoration is awaited.
        if (this.stopping) return
        const now = Date.now()
        // Session restoration can span a wall-clock rollback; future members keep their timer obligation.
        admitted = group.filter(member => this.target(member, now) <= now)
        if (admitted.length === 0) continue
        const recurring = admitted.filter((member): member is ScheduleTask & { record: RecurringScheduleRecord } =>
          isRecurringScheduleRecord(member.record))
        const occurrences = recurring.map(member => ({
          task: member, occurrence: resolveRecurringOccurrence(member.record, now),
        }))
        const text = isRecurringScheduleRecord(task.record)
          ? renderRecurringReminderBatchFraming(occurrences.map(({ task: member, occurrence }) => ({
            record: member.record, occurrenceAt: occurrence.occurrenceAt,
          })))
          : renderReminderFraming(task.record)
        const message = createUserMessage({
          content: [{ type: 'text', text }], source: { kind: 'schedule' },
        })
        // followup synchronously appends the inbox splice before flush observes the Session.
        resolved.agent.followup(message)
        const flushed = await this.ctx.sessions.flush(resolved.agent.session)
        if (!flushed) throw new Error('Session persistence did not acknowledge the reminder')
        const deliveredAt = new Date(Date.now()).toISOString()
        if (!isRecurringScheduleRecord(task.record)) {
          await this.commit({
            ...task, status: 'inactive',
            ...appendDelivery(task, { scheduledAt: task.record.scheduledAt, deliveredAt, messageId: message.id }, this.retention),
          })
          committed.add(task.record.id)
        }
        for (const { task: member, occurrence } of occurrences) {
          await this.commit({
            ...member,
            record: { ...member.record, scheduledAt: occurrence.nextScheduledAt ?? occurrence.occurrenceAt },
            status: occurrence.nextScheduledAt === undefined ? 'inactive' : 'active',
            ...appendDelivery(member, { scheduledAt: occurrence.occurrenceAt, deliveredAt, messageId: message.id }, this.retention),
          })
          committed.add(member.record.id)
        }
      } catch (error: unknown) {
        // Successful commits and targets made future by clock rollback keep their timer obligation.
        const pending = admitted.filter(member => !committed.has(member.record.id))
        const failedAt = Date.now()
        for (const member of pending) {
          if (Date.parse(member.record.scheduledAt) <= failedAt) failed.add(member.record.id)
        }
        const ids = pending.map(member => member.record.id)
        this.ctx.logger.warn(`schedule: reminders ${JSON.stringify(ids)} were not acknowledged: ${String(error)}`)
      }
    }
    if (this.stopping) return
    const next = this.tasks().filter(task => task.status === 'active' && !failed.has(task.record.id))
      .reduce<number | undefined>((at, task) => {
      const target = this.target(task, Date.now())
        return at === undefined ? target : Math.min(at, target)
      }, undefined)
    if (next !== undefined && Number.isFinite(next)) {
      this.timer = setTimeout(() => { this.timer = undefined; this.requestDrive() },
        Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)))
      this.timer.unref()
    }
  }
}
