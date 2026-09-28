import { Temporal } from '@js-temporal/polyfill'

// Must match the contract's small exact IANA allowlist; the contract stores metadata, not tzdb rules.
export const SUPPORTED_TIME_ZONES = [
  'UTC', 'America/Los_Angeles', 'America/New_York', 'America/Chicago',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Shanghai',
  'Asia/Tokyo', 'Asia/Singapore', 'Asia/Kolkata', 'Australia/Sydney',
] as const

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

export function isSupportedTimeZone(value: string): boolean {
  return SUPPORTED_TIME_ZONES.includes(value as typeof SUPPORTED_TIME_ZONES[number])
}

// A wall time must identify exactly one instant; DST gaps and overlaps are both rejected.
export function localToZonedIso(value: string, timeZone: string): string {
  if (!isSupportedTimeZone(timeZone) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return ''
  try {
    return Temporal.PlainDateTime.from(value, { overflow: 'reject' })
      .toZonedDateTime(timeZone, { disambiguation: 'reject' })
      .toInstant().toString({ smallestUnit: 'millisecond' })
  } catch {
    return ''
  }
}

export function zonedInputTime(date: Date, timeZone: string): string {
  if (!isSupportedTimeZone(timeZone) || Number.isNaN(date.getTime())) return ''
  return Temporal.Instant.from(date.toISOString()).toZonedDateTimeISO(timeZone)
    .toPlainDateTime().toString({ smallestUnit: 'minute' })
}

export function utcOffsetAt(iso: string, timeZone: string): string {
  if (!isSupportedTimeZone(timeZone)) return ''
  try {
    return `UTC${Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone).offset}`
  } catch {
    return ''
  }
}
