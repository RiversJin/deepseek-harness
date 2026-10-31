/**
 * Opt-in request clock context. Eligible steps add durable,
 * source-attributed time readings to the request history.
 *
 * @module @deepseek-ai/dsh-time-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'time-context': { kind: 'time-context' } & ContextFormed
  }
}

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import {
  deriveBrowserTimeZoneContext,
  renderBrowserTimeZoneContext,
} from './request-zone.ts'
import type { BrowserTimeZoneContext } from './request-zone.ts'
import { createTimestampFormatter, formatTimestamp } from './timestamp.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'time-context'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest time-context readings. */
    timeContext: TimeContextProjection
  }
}

const clockStateSchema = zod.object({
  /** Time of the latest model-visible event (user/assistant message, tool result), or null. */
  lastMessageTime: zod.number().nullable(),
  /** Time of this plugin's latest durable injection, or null. */
  lastInjectionTime: zod.number().nullable(),
  /** Surface node of the latest durable injection, for detecting context rewrites. */
  lastInjectionSeq: zod.number().int().nonnegative().nullable(),
  /** Latest injection time in the open turn, or null before that turn receives one. */
  lastTurnInjectionTime: zod.number().nullable(),
  /** Real user messages appended after the latest durable injection. */
  userMessagesSinceInjection: zod.number().int().nonnegative(),
})

const timeContextStateSchema = clockStateSchema.extend({
  openTurn: zod.number().int().nullable(),
  /** Clock state before the latest admitted user turn, for whole-turn retry. */
  request: zod.object({
    startSeq: zod.number().int().nonnegative(),
    turn: zod.number().int().nullable(),
    before: clockStateSchema,
  }).nullable(),
})

type ClockState = zod.infer<typeof clockStateSchema>
/** Folded time-context readings. */
type TimeContextProjection = zod.infer<typeof timeContextStateSchema>

function clockState(state: ClockState): ClockState {
  return {
    lastMessageTime: state.lastMessageTime,
    lastInjectionTime: state.lastInjectionTime,
    lastInjectionSeq: state.lastInjectionSeq,
    lastTurnInjectionTime: state.lastTurnInjectionTime,
    userMessagesSinceInjection: state.userMessagesSinceInjection,
  }
}

/** Evaluate a proposed retry against its pending retraction without committing it. */
function requestClock(state: TimeContextProjection, messages: readonly UserMessage[]): ClockState {
  const checkpoint = state.request
  if (checkpoint === null) return state
  for (const message of messages) {
    const source = message.source as UserMessage['source'] & { dshRetry?: unknown }
    if (source.kind !== 'user' || typeof source.dshRetry !== 'object' || source.dshRetry === null) continue
    const retry = source.dshRetry as { startSeq?: unknown; endSeq?: unknown }
    if (retry.startSeq === checkpoint.startSeq
      && typeof retry.endSeq === 'number' && Number.isSafeInteger(retry.endSeq)
      && retry.endSeq >= checkpoint.startSeq) {
      return { ...checkpoint.before, lastTurnInjectionTime: null }
    }
  }
  return state
}

/** The agent registry that owns pre-step processing. */
export const inject = ['agents', 'sessionProjections']

/** Request-preparation clock formatting and append scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Fallback display zone when the open turn has no unique browser zone. Omit to use the process zone. */
  timeZone?: string
  /** Minimum milliseconds between durable injections in one session. Defaults to 600000 (10 minutes); 0 injects at every eligible step. */
  refreshIntervalMs?: number
  /** Also refresh after this many user messages; 0 (the default) disables the count threshold. */
  refreshUserMessageCount?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  refreshIntervalMs: z.number(),
  refreshUserMessageCount: z.number(),
})

/** Format a non-negative elapsed millisecond count as compact whole-second units. */
function formatDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

/** Collect already-entered and proposed user messages belonging to one open turn. */
function requestMessages(agent: Agent, turn: number, proposed: readonly UserMessage[]): UserMessage[] {
  const entered: UserMessage[] = []
  for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = agent.session.eventAt(SessionSeq(seq))
    if (event?.type === 'turn/start' && event.data.turn === turn) {
      return [...entered.reverse(), ...proposed]
    }
    if (event?.type === 'user/message') entered.push(event.data)
  }
  return [...proposed]
}

function renderText(
  now: number,
  turn: number,
  step: number,
  previous: number | undefined,
  formatter: Intl.DateTimeFormat,
  timeZone: string,
  browserContext: BrowserTimeZoneContext,
): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  const browserText = renderBrowserTimeZoneContext(browserContext)
  return `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}\n`
    + `${browserText}\n`
    + `Elapsed since the preceding ${baseline}: ${elapsed}.`
}

/** Reject refresh intervals that cannot represent an exact elapsed-millisecond threshold. */
function validateRefreshInterval(refreshIntervalMs: number): void {
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 0) {
    throw new TypeError(
      `time-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

/**
 * Register a prepended pre-step listener for the lifetime of `ctx`.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - time zone and durable refresh scheduling configuration.
 * @throws when the refresh interval is invalid or the configured or process time zone cannot be resolved.
 */
export function apply(ctx: Context, config: Config): void {
  const timeZone = config.timeZone
  const refreshIntervalMs = config.refreshIntervalMs ?? 600_000
  validateRefreshInterval(refreshIntervalMs)
  const refreshUserMessageCount = config.refreshUserMessageCount ?? 0
  if (!Number.isSafeInteger(refreshUserMessageCount) || refreshUserMessageCount < 0) {
    throw new TypeError('time-context: refreshUserMessageCount must be a non-negative safe integer')
  }
  let fallbackFormatter: Intl.DateTimeFormat
  try {
    fallbackFormatter = createTimestampFormatter(timeZone)
  } catch (error: unknown) {
    const message = timeZone === undefined
      ? 'time-context: failed to resolve the system time zone'
      : `time-context: invalid IANA timeZone ${JSON.stringify(timeZone)}`
    throw new Error(message, { cause: error })
  }
  const fallbackTimeZone = fallbackFormatter.resolvedOptions().timeZone
  const formatters = new Map<string, Intl.DateTimeFormat>([[fallbackTimeZone, fallbackFormatter]])

  /** Resolve and cache one request-local timestamp formatter. */
  const formatterFor = (selectedTimeZone: string): Intl.DateTimeFormat => {
    const existing = formatters.get(selectedTimeZone)
    if (existing !== undefined) return existing
    const created = createTimestampFormatter(selectedTimeZone)
    formatters.set(selectedTimeZone, created)
    return created
  }

  ctx.sessionProjections.register({
    key: 'timeContext',
    stateVersion: 5,
    stateSchema: timeContextStateSchema,
    init: () => ({ lastMessageTime: null, lastInjectionTime: null, lastInjectionSeq: null, lastTurnInjectionTime: null, userMessagesSinceInjection: 0,
      openTurn: null, request: null }),
    apply: (state, event) => {
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        const openTurn = event.type === 'turn/start' ? event.data.turn : null
        return state.lastTurnInjectionTime === null && state.openTurn === openTurn
          ? state : { ...state, openTurn, lastTurnInjectionTime: null }
      }
      if (event.type === 'developer/message') {
        const source: { kind: string; form?: unknown } = event.data.message.source
        if (source.kind === 'plugin:dsh-retry' && source.form === 'reset'
          && state.request !== null && event.sourceEventSeqs?.includes(SessionSeq(state.request.startSeq))) {
          // The original turn remains in the durable log, but no longer
          // contributes either elapsed time or the user-message threshold.
          return { ...state, ...state.request.before, lastTurnInjectionTime: null, request: null }
        }
        return state
      }
      // Rewriting historical context is not new conversational activity.
      // In particular, recall expiry must not shorten the user's idle gap.
      if (event.surfaceOp !== 'append') return state
      if (event.type === 'user/message') {
        const injected = event.surfaceOp === 'append' && event.data.source.kind === name
        const directUser = event.surfaceOp === 'append' && event.data.source.kind === 'user'
        const request = directUser && (state.request === null || state.request.turn !== state.openTurn)
          ? { startSeq: event.seq, turn: state.openTurn, before: clockState(state) } : state.request
        const withMessage = state.lastMessageTime === event.time
          ? state
          : { ...state, lastMessageTime: event.time }
        if (!injected) return directUser
          ? { ...withMessage, request, userMessagesSinceInjection: Math.min(Number.MAX_SAFE_INTEGER, state.userMessagesSinceInjection + 1) }
          : withMessage
        return {
          ...withMessage,
          lastInjectionTime: event.time,
          lastInjectionSeq: event.seq,
          lastTurnInjectionTime: event.time,
          userMessagesSinceInjection: 0,
        }
      }
      if (event.type === 'assistant/message' || event.type === 'tool/result') {
        return state.lastMessageTime === event.time ? state : { ...state, lastMessageTime: event.time }
      }
      return state
    },
  })

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const now = Date.now()
    const stored = ctx.sessionProjections.stateOf(agent.session, 'timeContext') as TimeContextProjection
    // Retry commits its surface replacement during agent/request, after this
    // hook. Preview the same rollback now; rejected preparation changes no state.
    const state = requestClock(stored, decision.messages)
    // Incoming messages are committed only after pre-step returns. Include them
    // without mutating the projection; a rejected request must not consume them.
    const userMessageCount = state.userMessagesSinceInjection
      + decision.messages.filter(message => message.source.kind === 'user').length
    const countDue = refreshUserMessageCount > 0 && userMessageCount >= refreshUserMessageCount
    if (refreshIntervalMs > 0 && !countDue) {
      const lastInjection = state.lastInjectionTime
      if (lastInjection != null
        && state.lastInjectionSeq !== null
        && agent.session.surface.nodes.includes(SessionSeq(state.lastInjectionSeq))
        && now >= lastInjection
        && now - lastInjection < refreshIntervalMs) return decision
    }
    /* v8 ignore next 6 -- every later step follows a recorded injection in the same turn */
    const previous = step === 1
      ? state.lastMessageTime ?? undefined
      : state.lastTurnInjectionTime ?? undefined
    const messages = requestMessages(agent, turn, decision.messages)
    const browser = deriveBrowserTimeZoneContext(messages)
    const selectedTimeZone = browser.kind === 'resolved' ? browser.timeZone : fallbackTimeZone
    const text = renderText(
      now,
      turn,
      step,
      previous,
      formatterFor(selectedTimeZone),
      selectedTimeZone,
      browser,
    )
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}
