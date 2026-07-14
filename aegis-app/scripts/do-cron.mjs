const DAY_MINUTES = 24 * 60

export function validateDigitalOceanCronSchedule(schedule, { name = 'cron schedule', minimumMinutes = 15 } = {}) {
  const normalized = schedule.trim()
  const fields = normalized.split(/\s+/)

  if (fields.length !== 5) {
    throw new Error(`${name} must be a five-field cron expression`)
  }

  const minutes = expandNumberField(fields[0], 0, 59, `${name} minute field`)
  const hours = expandNumberField(fields[1], 0, 23, `${name} hour field`)
  expandNumberField(fields[2], 1, 31, `${name} day-of-month field`)
  expandNumberField(fields[3], 1, 12, `${name} month field`)
  expandNumberField(fields[4], 0, 7, `${name} day-of-week field`)
  assertMinimumCadence(minutes, hours, minimumMinutes, name)

  return normalized
}

function assertMinimumCadence(minutes, hours, minimumMinutes, name) {
  const runMinutes = hours
    .flatMap((hour) => minutes.map((minute) => hour * 60 + minute))
    .sort((left, right) => left - right)

  if (runMinutes.length < 2) return

  for (let index = 0; index < runMinutes.length; index += 1) {
    const current = runMinutes[index]
    const next = runMinutes[(index + 1) % runMinutes.length] + (index === runMinutes.length - 1 ? DAY_MINUTES : 0)
    const interval = next - current

    if (interval < minimumMinutes) {
      throw new Error(
        `${name} must not run more often than every ${minimumMinutes} minutes for DigitalOcean App Platform scheduled jobs`,
      )
    }
  }
}

function expandNumberField(field, minimum, maximum, label) {
  const values = new Set()

  for (const part of field.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) {
      throw new Error(`${label} contains an empty list item`)
    }

    const [rangePart, stepPart, extra] = trimmed.split('/')
    if (extra !== undefined) {
      throw new Error(`${label} has invalid step syntax: ${trimmed}`)
    }

    const step = stepPart === undefined ? 1 : parseNumber(stepPart, minimum, maximum, `${label} step`)
    if (step <= 0) {
      throw new Error(`${label} step must be positive`)
    }

    const [start, end] = expandRange(rangePart, stepPart !== undefined, minimum, maximum, label)
    for (let value = start; value <= end; value += step) {
      values.add(value)
    }
  }

  return [...values].sort((left, right) => left - right)
}

function expandRange(rangePart, steppedSingleValue, minimum, maximum, label) {
  if (rangePart === '*') return [minimum, maximum]

  if (rangePart.includes('-')) {
    const [startPart, endPart, extra] = rangePart.split('-')
    if (extra !== undefined) {
      throw new Error(`${label} has invalid range syntax: ${rangePart}`)
    }

    const start = parseNumber(startPart, minimum, maximum, `${label} range start`)
    const end = parseNumber(endPart, minimum, maximum, `${label} range end`)
    if (start > end) {
      throw new Error(`${label} range start must be less than or equal to range end`)
    }
    return [start, end]
  }

  const value = parseNumber(rangePart, minimum, maximum, label)
  return steppedSingleValue ? [value, maximum] : [value, value]
}

function parseNumber(value, minimum, maximum, label) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a number`)
  }

  const parsed = Number(value)
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`)
  }

  return parsed
}
