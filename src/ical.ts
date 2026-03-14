import * as actualApi from '@actual-app/api'
import ical, { ICalCalendarMethod } from 'ical-generator'
import { RRule } from 'rrule'
import { DateTime, DurationLikeObject } from 'luxon'
import { RecurConfig, ScheduleEntity } from '@actual-app/api/@types/loot-core/src/types/models'
import { formatCurrency } from './helpers/number'
import { existsSync, mkdirSync } from 'node:fs'
import logger from './helpers/logger'

const {
  ACTUAL_SERVER,
  ACTUAL_MAIN_PASSWORD,
  ACTUAL_SYNC_ID,
  ACTUAL_SYNC_PASSWORD,
  ACTUAL_PATH = '.actual-cache',
  TZ = 'UTC',
} = process.env

if (!ACTUAL_SERVER || !ACTUAL_MAIN_PASSWORD || !ACTUAL_SYNC_ID) {
  throw new Error('Missing ACTUAL_SERVER, ACTUAL_MAIN_PASSWORD or ACTUAL_SYNC_ID')
}

// Actual SDK throws unhandled exceptions on downloadBudget if the SyncID is wrong, which breaks the app
// This should be fixed on Actual SDK side, but for now we can just ignore unhandled exceptions
// This may hide other issues, but it's better than breaking the app
process.on('uncaughtException', (error) => {
  logger.error('Unhandled exception', error)
})

const getSchedules = async () => {
  if (!existsSync(ACTUAL_PATH)) {
    logger.debug('Creating directory:', ACTUAL_PATH)
    mkdirSync(ACTUAL_PATH)
  }

  await actualApi.init({
    dataDir: ACTUAL_PATH,
    serverURL: ACTUAL_SERVER,
    password: ACTUAL_MAIN_PASSWORD,
    verbose: false,
  })

  await actualApi.downloadBudget(ACTUAL_SYNC_ID, {
    password: ACTUAL_SYNC_PASSWORD,
  })

  const query = actualApi.q('schedules')
    .filter({
      completed: false,
      tombstone: false,
    })
    .select(['*'])

  const { data } = await actualApi.aqlQuery(query) as { data: ScheduleEntity[] }

  return data
}

const resolveFrequency = (frequency: string) => {
  switch (frequency) {
    case 'yearly':
      return RRule.YEARLY
    case 'monthly':
      return RRule.MONTHLY
    case 'weekly':
      return RRule.WEEKLY
    case 'daily':
      return RRule.DAILY
    default:
      throw new Error(`Invalid frequency: ${frequency}`)
  }
}

export const generateIcal = async () => {
  const schedules = await getSchedules()
  const today = DateTime.now()

  logger.debug(`Found ${schedules.length} schedules`)

  const calendar = ical({
    name: 'Actual Balance iCal',
    // Homepage use an ical-date-parser, which breaks with timezone configured calendars
    // https://github.com/zxqx/ical-date-parser/issues/3
    // timezone: TZ,
  })

  // A method is required for outlook to display event as an invitation
  calendar.method(ICalCalendarMethod.REQUEST)

  schedules.forEach((schedule) => {
    logger.debug(schedule, 'Processing Schedule')
    const recurringData = schedule._date
    const nextDate = DateTime.fromISO(schedule.next_date)

    if (typeof recurringData === 'string') {
      logger.debug({ recurringData }, `Skipping non-recurring schedule with string date: ${schedule.name}`)
      return
    }

    const getEndDate = () => {
      if (recurringData.endMode === 'never') {
        return
      }

      if (recurringData.endMode === 'after_n_occurrences') {
        const windowMap = {
          daily: 'day',
          weekly: 'week',
          monthly: 'month',
          yearly: 'year',
        } satisfies Record<RecurConfig['frequency'], keyof DurationLikeObject>

        return DateTime.fromISO(recurringData.start).plus({
          [windowMap[recurringData.frequency]]: recurringData.endOccurrences,
        }).toJSDate()
      }

      if (!recurringData.endDate) {
        return
      }

      return DateTime.fromISO(recurringData.endDate).toJSDate()
    }

    const getStartDate = () => {
      if (recurringData.endMode ===  'never') {
        return nextDate.toJSDate()
      }

      return DateTime.fromISO(recurringData.start).toJSDate()
    }

    const getCount = () => {
      if (recurringData.endMode ===  'never') {
        const nextDateDiff = today.diff(nextDate, 'days').days

        // nextDate is in the future
        if (nextDateDiff < 0) {
          if (recurringData.frequency === 'daily') {
            return 30
          }

          if (recurringData.frequency === 'weekly') {
            return 4
          }

          if (recurringData.frequency === 'monthly') {
            return 12
          }

          return 2
        }

        if (recurringData.frequency === 'daily') {
          return Math.ceil(nextDateDiff)
        }

        if (recurringData.frequency === 'weekly') {
          return Math.ceil(nextDateDiff / 7)
        }

        if (recurringData.frequency === 'monthly') {
          return Math.ceil(nextDateDiff / 30)
        }

        return Math.ceil(nextDateDiff / 365)
      }

      if (recurringData.endMode === 'after_n_occurrences') {
        return recurringData.endOccurrences
      }

      return
    }

    const formatAmount = () => {
      const amount = schedule._amount
      if (typeof amount === 'number') {
        return formatCurrency(amount)
      }

      return `${formatCurrency(amount.num1)} ~ ${formatCurrency(amount.num2)}`
    }

    // Handle non-recurring schedules separately
    if (!recurringData.frequency) {
      logger.debug(`Generating single event for ${schedule.name}`)

      return calendar.createEvent({
        start: nextDate.toJSDate(),
        summary: `${schedule.name} (${formatAmount()})`,
        allDay: true,
        timezone: TZ,
      })
    }

    // Only create RRule for recurring schedules
    const ruleOptions = {
      freq: resolveFrequency(recurringData.frequency),
      dtstart: getStartDate(),
      until: getEndDate(),
      count: getCount(),
      interval: recurringData.interval || 1,
      tzid: TZ,
    }

    // Limit number of  generated events to avoid performance and/or import issues
    const envYears = parseInt(process.env.ACTUAL_SYNC_YEARS || '1', 10)
    const yearsToSync = isNaN(envYears) ? 1 : envYears

    const safetyLimit = new Date()
    safetyLimit.setFullYear(safetyLimit.getFullYear() + yearsToSync)

    if (!ruleOptions.until || ruleOptions.until > safetyLimit) {
      ruleOptions.until = safetyLimit

      ruleOptions.count = undefined

      logger.debug(`Capping schedule to ${yearsToSync} year(s): ${schedule.name}`)
    }

    logger.debug(ruleOptions, schedule.name)
    const rule = new RRule(ruleOptions)

    logger.debug(`Generating events for ${schedule.name}. ${rule.count()} events`)

    const moveOnWeekend = (date: Date) => {
      const dateTime = DateTime.fromJSDate(date)

      if (!recurringData.skipWeekend) {
        return dateTime
      }

      if (dateTime.weekday !== 6 && dateTime.weekday !== 7) {
        return dateTime
      }

      if (recurringData.weekendSolveMode === 'after') {
        const daysToMove = dateTime.weekday === 6 ? 2 : 1
        return dateTime.plus({ days: daysToMove })
      }

      if (recurringData.weekendSolveMode === 'before') {
        const daysToMove = dateTime.weekday === 6 ? -1 : -2
        return dateTime.plus({ days: daysToMove })
      }

      throw new Error('Invalid weekendSolveMode')
    }

   try {
      return rule.all()
        .filter((date) => {
          return DateTime.fromJSDate(date) >= nextDate
        })
        .map((date) => {
          return calendar.createEvent({
            start: moveOnWeekend(date).toJSDate(),
            summary: `${schedule.name} (${formatAmount()})`,
            allDay: true,
            timezone: TZ,
          })
        })
    } catch (err) {
      logger.error({ err, scheduleName: schedule.name }, 'Failed to generate events for schedule')
      return []
    }
  })

  return calendar.toString()
}
