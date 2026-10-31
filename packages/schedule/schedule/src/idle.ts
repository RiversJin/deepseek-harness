/** Quiet-period arithmetic and delivery options shared by durable and tool callers. */
import { Temporal } from '@js-temporal/polyfill'
import { z } from 'zod'
import { ScheduleInputError, ScheduleLogError, canonicalizeTimeZone, scheduleTitle } from './domain.ts'
import type { IdleScheduleRecord, ScheduleActiveWindow, ScheduleDeliveryInput, ScheduleDeliveryOptions, ScheduleId } from './types.ts'

const clock = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/
const windowSchema = z.object({
  start: z.string().regex(clock),
  end: z.string().refine(value => value === '24:00:00' || clock.test(value)),
  time_zone: z.string(),
}).strict().refine(value => value.start !== value.end)
const optionsSchema = z.object({
  activeWindow: windowSchema.optional(),
  notification: z.enum(['prompt', 'time_passing']).optional(),
  retain: z.enum(['all', 'latest']).optional(),
}).strict()

/** Decode delivery choices while retaining omission in existing records.
 * @param value - Durable option fields.
 * @returns Validated independent delivery choices.
 */
export function decodeDeliveryOptions(value: unknown): ScheduleDeliveryOptions {
  const result = optionsSchema.safeParse(value)
  if (!result.success) throw new ScheduleLogError('Invalid schedule delivery options')
  if (result.data.activeWindow) canonicalizeTimeZone(result.data.activeWindow.time_zone)
  return result.data
}

/** Merge explicitly supplied delivery choices with a stored task.
 * @param current - Existing choices.
 * @param input - Tool or management choices.
 * @returns Validated merged choices.
 */
export function deliveryOptions(current: ScheduleDeliveryOptions, input: ScheduleDeliveryInput): ScheduleDeliveryOptions {
  const value = {
    ...(current.activeWindow === undefined ? {} : { activeWindow: current.activeWindow }),
    ...(current.notification === undefined ? {} : { notification: current.notification }),
    ...(current.retain === undefined ? {} : { retain: current.retain }),
    ...(input.active_window === undefined ? {} : { activeWindow: input.active_window }),
    ...(input.notification === undefined ? {} : { notification: input.notification }),
    ...(input.retain === undefined ? {} : { retain: input.retain }),
  }
  try { return decodeDeliveryOptions(value) }
  catch (error) {
    if (error instanceof ScheduleInputError) throw error
    if (!(error instanceof ScheduleLogError)) throw error
    throw new ScheduleInputError('invalid_rule', 'Invalid schedule delivery options.')
  }
}

/** First permitted instant at or after a target, including windows crossing midnight.
 * @param target - Candidate epoch milliseconds.
 * @param window - Daily local hours, or unrestricted delivery.
 * @returns Candidate itself during allowed hours, otherwise the next opening.
 */
export function nextInWindow(target: number, window?: ScheduleActiveWindow): number {
  if (!window) return target
  const local = Temporal.Instant.fromEpochMilliseconds(target).toZonedDateTimeISO(window.time_zone)
  const time = local.toPlainTime().toString({ smallestUnit: 'second' })
  const overnight = window.end < window.start
  const inside = overnight ? time >= window.start || time < window.end : time >= window.start && time < window.end
  if (inside) return target
  const date = !overnight && time >= window.end ? local.toPlainDate().add({ days: 1 }) : local.toPlainDate()
  return date.toZonedDateTime({ timeZone: window.time_zone, plainTime: window.start }).epochMilliseconds
}

/** Create an activity-anchored recurring task.
 * @param id - Stable task identity.
 * @param prompt - User-selected reminder text.
 * @param seconds - Positive quiet duration, representable in whole milliseconds.
 * @param now - Initial activity anchor.
 * @param title - Task title.
 * @returns Complete durable quiet-period rule.
 */
export function createIdleScheduleRecord(id: ScheduleId, prompt: string, seconds: number, now: number, title: string): IdleScheduleRecord {
  const interval = seconds * 1000
  if (!Number.isSafeInteger(interval) || interval <= 0 || !Number.isSafeInteger(now + interval)) {
    throw new ScheduleInputError('invalid_rule', 'idle_seconds must be positive and representable in whole milliseconds.')
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw new ScheduleInputError('invalid_prompt', 'prompt must be non-empty after trimming.')
  const target = new Date(now + interval)
  if (!Number.isFinite(target.getTime()) || target.getUTCFullYear() < 1 || target.getUTCFullYear() > 9999) throw new ScheduleInputError('time_out_of_range', 'Schedule time must use a four-digit year.')
  const scheduledAt = target.toISOString()
  return Object.freeze({ id, kind: 'idle', title: scheduleTitle(title), prompt: prompt.trim(), idleSeconds: seconds,
    quietSince: new Date(now).toISOString(), scheduledAt })
}

/** Move an idle task to the end of its latest completed activity.
 * @param record - Existing idle task.
 * @param endedAt - Activity completion time.
 * @returns Task with its next quiet-period target.
 */
export function afterActivity(record: IdleScheduleRecord, endedAt: number): IdleScheduleRecord {
  const quietSince = Math.max(Date.parse(record.quietSince), endedAt)
  return { ...record, quietSince: new Date(quietSince).toISOString(),
    scheduledAt: new Date(nextInWindow(quietSince + record.idleSeconds * 1000, record.activeWindow)).toISOString() }
}
