/** Time notification text and durable activity observations. */

/** English guidance selected for the time-passing task. */
export const TIME_PASSING_GUIDANCE = 'Time-passing notifications are yours to configure. From 10:00 each day, a notification arrives once your quiet period reaches the interval you selected. The initial interval is 30 minutes. The quiet period starts again when each round of activity ends. Use schedule_list to find the notification task, schedule_update to adjust it, schedule_delete to turn it off, and schedule_create to create it again. When a notification arrives, you may choose what to do next or quietly end the turn. Your context retains the latest time notification.'

/** Render an elapsed duration using days, hours, minutes and seconds.
 * @param ms - Elapsed milliseconds.
 * @returns Compact nonnegative duration.
 */
export function duration(ms: number): string {
  let seconds = Math.floor(Math.max(0, ms) / 1000)
  const days = Math.floor(seconds / 86400); seconds %= 86400
  const hours = Math.floor(seconds / 3600); seconds %= 3600
  const minutes = Math.floor(seconds / 60); seconds %= 60
  return [...(days ? [`${days}d`] : []), ...(hours ? [`${hours}h`] : []), ...(minutes ? [`${minutes}m`] : []), `${seconds}s`].join(' ')
}

/** Render the current clock and available elapsed durations.
 * @param now - Actual delivery time.
 * @param quietSince - Latest activity completion.
 * @param previous - Previous notification receipt, if any.
 * @param human - Latest human message time, if any.
 * @param zone - Display time zone.
 * @returns Notification body.
 */
export function timeNotification(now: number, quietSince: number, previous: number | undefined, human: number | undefined, zone: string): string {
  return ['[Time passing]',
    `Current time: ${new Date(now).toLocaleString('sv-SE', { timeZone: zone })} (${zone})`,
    `Time spent quiet: ${duration(now - quietSince)}`,
    ...(previous === undefined ? [] : [`Time since the previous time notification: ${duration(now - previous)}`]),
    ...(human === undefined ? [] : [`Time since the user's last message: ${duration(now - human)}`]),
  ].join('\n')
}
