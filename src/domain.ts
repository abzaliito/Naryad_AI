import type { Brigade, Catalogs, DateRange, Equipment, Material, Order, OrderFilters, OrderStatus, Priority, User, Verdict } from './types'

export const TIME_ZONE = 'Asia/Qyzylorda'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const LOCAL_PARTS_FORMATTER = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })

export const STATUS_LABELS: Record<OrderStatus, string> = {
  issued: 'Выдан', accepted: 'Принят в работу', queued: 'В очереди', rejected: 'Отклонён',
  in_progress: 'В работе', paused: 'Приостановлен', completed: 'Исполнено',
  ai_review: 'Проверка ИИ', rework: 'На доработку', closed: 'Закрыт', cancelled: 'Отменён',
}
/** Semantic color names for badges; status remains readable without color. */
export const STATUS_COLORS: Record<OrderStatus, string> = {
  issued: 'blue', accepted: 'cyan', queued: 'purple', rejected: 'red', in_progress: 'amber',
  paused: 'slate', completed: 'green', ai_review: 'indigo', rework: 'orange', closed: 'green', cancelled: 'slate',
}
export const PRIORITY_LABELS: Record<Priority, string> = { emergency: 'Аварийный', high: 'Высокий', normal: 'Обычный', planned: 'Плановый' }
export const PRIORITY_COLORS: Record<Priority, string> = { emergency: 'red', high: 'orange', normal: 'blue', planned: 'slate' }
export const VERDICT_LABELS: Record<Verdict, string> = { accepted: 'Принято', remarks: 'Принято с замечаниями', rework: 'Требует доработки' }
export const ROLE_LABELS = { master: 'Мастер смены', worker: 'Исполнитель', manager: 'Руководитель', admin: 'Администратор' } as const
export const ACTIVE_STATUSES: OrderStatus[] = ['issued', 'accepted', 'queued', 'in_progress', 'paused', 'rework']
export const KANBAN_STATUSES: OrderStatus[] = ['issued', 'accepted', 'queued', 'in_progress', 'paused', 'ai_review', 'rework', 'closed']

type DateValue = string | number | Date | null | undefined
function timestamp(value: DateValue): number { return value == null ? NaN : new Date(value).getTime() }
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits
const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value))

export function formatDate(value: DateValue, options: Intl.DateTimeFormatOptions = {}): string {
  const ms = timestamp(value)
  return Number.isFinite(ms) ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', timeZone: TIME_ZONE, ...options }).format(ms) : '—'
}
export function formatTime(value: DateValue): string { return formatDate(value, { day: undefined, month: undefined, hour: '2-digit', minute: '2-digit' }) }
export function formatDateTime(value: DateValue): string { return formatDate(value, { hour: '2-digit', minute: '2-digit' }) }
export function durationHours(start: DateValue, end: DateValue = Date.now()): number {
  const a = timestamp(start), b = timestamp(end)
  return Number.isFinite(a) && Number.isFinite(b) ? round(Math.max(0, b - a) / HOUR, 2) : 0
}
export function formatDuration(hours: number): string {
  const minutes = Math.max(0, Math.round(hours * 60))
  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ''}`
}
export function relativeTime(value: DateValue, now: DateValue = Date.now()): string {
  const delta = timestamp(value) - timestamp(now)
  if (!Number.isFinite(delta)) return '—'
  if (Math.abs(delta) < MINUTE) return 'сейчас'
  const fmt = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })
  if (Math.abs(delta) < HOUR) return fmt.format(Math.round(delta / MINUTE), 'minute')
  if (Math.abs(delta) < DAY) return fmt.format(Math.round(delta / HOUR), 'hour')
  return fmt.format(Math.round(delta / DAY), 'day')
}

/** Expiry is an overlay. Review time never adds to the executor's overdue time. */
export function isOverdue(order: Order, now: DateValue = Date.now()): boolean {
  if (!ACTIVE_STATUSES.includes(order.status)) return false
  return timestamp(order.dueAt) < timestamp(now)
}
export function completedTime(order: Order): string | undefined {
  return order.completedAt || order.completion?.submittedAt || [...order.events].reverse().find(event => event.toStatus === 'completed')?.at
}
export function isOnTime(order: Order): boolean {
  const end = timestamp(completedTime(order))
  return Number.isFinite(end) && end <= timestamp(order.dueAt)
}

/** Offset is calculated by IANA rules rather than by the computer's local zone. */
function localParts(date: DateValue): Record<string, number> {
  const parts = LOCAL_PARTS_FORMATTER.formatToParts(timestamp(date))
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
}
function zonedTimestamp(year: number, month: number, day: number, hour = 0): number {
  const target = Date.UTC(year, month - 1, day, hour)
  let result = target
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(result)
    const difference = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - target
    result -= difference
    if (difference === 0) break
  }
  return result
}
/** Current shift: day 08:00–20:00 or night 20:00–08:00, in Asia/Qyzylorda. */
export function getShiftRange(now: DateValue = Date.now()): { from: Date; to: Date; label: string; isDay: boolean } {
  const p = localParts(now)
  const isDay = p.hour >= 8 && p.hour < 20
  const start = zonedTimestamp(p.year, p.month, p.day, isDay ? 8 : p.hour < 8 ? -4 : 20)
  return { from: new Date(start), to: new Date(start + 12 * HOUR), label: isDay ? 'Дневная смена · 08:00–20:00' : 'Ночная смена · 20:00–08:00', isDay }
}
export function getPeriodRange(period: 'shift' | 'day' | 'week' | 'month' | 'quarter' | 'all', now: DateValue = Date.now()): DateRange {
  if (period === 'all') return {}
  if (period === 'shift') return getShiftRange(now)
  const p = localParts(now), dayStart = zonedTimestamp(p.year, p.month, p.day)
  const days = { day: 1, week: 7, month: 30, quarter: 90 }[period]
  return { from: new Date(dayStart - (days - 1) * DAY), to: new Date(timestamp(now) + 1) }
}
export function isInRange(date: DateValue, range: DateRange = {}): boolean {
  const ms = timestamp(date)
  return Number.isFinite(ms) && (!range.from || ms >= timestamp(range.from)) && (!range.to || ms < timestamp(range.to))
}

/** Default date basis is issue time. Ratings use closure time explicitly. */
export function filterOrders(orders: Order[], filters: OrderFilters = {}, catalogs?: Catalogs, now: DateValue = Date.now()): Order[] {
  const query = filters.search?.trim().toLocaleLowerCase('ru')
  return orders.filter(order => {
    const date = filters.dateField === 'completedAt' ? completedTime(order) : order[filters.dateField || 'createdAt']
    if ((filters.from || filters.to) && !isInRange(date, filters)) return false
    if (filters.siteId && order.siteId !== filters.siteId) return false
    if (filters.equipmentId && order.equipmentId !== filters.equipmentId) return false
    if (filters.assigneeId && order.assigneeId !== filters.assigneeId) return false
    if (filters.brigadeId && (order.brigadeId || catalogs?.users.find(user => user.id === order.assigneeId)?.brigadeId) !== filters.brigadeId) return false
    if (filters.priority && order.priority !== filters.priority) return false
    if (filters.type && order.type !== filters.type) return false
    if (filters.status === 'overdue' && !isOverdue(order, now)) return false
    if (filters.status && filters.status !== 'overdue' && order.status !== filters.status) return false
    if (query) {
      const equipment = catalogs?.equipment.find(item => item.id === order.equipmentId)
      const assignee = catalogs?.users.find(user => user.id === order.assigneeId)
      const text = [order.number, order.title, order.description, equipment?.name, equipment?.inventory, assignee?.name].join(' ').toLocaleLowerCase('ru')
      if (!text.includes(query)) return false
    }
    return true
  })
}

export type WorkerStatus = 'free' | 'busy' | 'queued' | 'off_shift'
export interface WorkerWorkload { user: User; status: WorkerStatus; label: string; color: string; current?: Order; active: Order[]; queued: Order[]; queueCount: number; overdueCount: number }
/** Existing queues precede newly queued work. A server sequence preserves FIFO even if its clock changes. */
export function compareQueuedOrders(a: Order, b: Order): number {
  const sequence = (order: Order) => Number.isSafeInteger(order.queueSequence) && order.queueSequence! > 0 ? order.queueSequence! : 0
  const aSequence = sequence(a), bSequence = sequence(b)
  if (aSequence || bSequence) {
    if (!aSequence) return -1
    if (!bSequence) return 1
    if (aSequence !== bSequence) return aSequence - bSequence
  }
  const entered = (order: Order) => {
    const time = timestamp(order.queuedAt || [...order.events].reverse().find(event => event.toStatus === 'queued')?.at || order.createdAt)
    return Number.isFinite(time) ? time : 0
  }
  return entered(a) - entered(b) || a.id.localeCompare(b.id)
}
export function getWorkerWorkload(user: User, orders: Order[], now: DateValue = Date.now()): WorkerWorkload {
  const active = orders.filter(order => order.assigneeId === user.id && ACTIVE_STATUSES.includes(order.status))
  const current = active.find(order => order.status === 'in_progress') || active.find(order => order.status === 'paused')
  const queued = active.filter(order => order.status === 'queued').sort(compareQueuedOrders)
  const occupied = current || active.find(order => order.status === 'accepted' || order.status === 'rework')
  const status: WorkerStatus = !user.onShift ? 'off_shift' : occupied ? 'busy' : queued.length ? 'queued' : 'free'
  const label = !user.onShift ? 'Не на смене' : current ? `${current.status === 'paused' ? 'Приостановлен' : 'В работе'} №${current.number}` : occupied ? `Принят №${occupied.number}` : queued.length ? `В очереди: ${queued.length}` : 'Свободен'
  return { user, status, label, color: { free: 'green', busy: 'amber', queued: 'blue', off_shift: 'slate' }[status], current, active, queued, queueCount: queued.length, overdueCount: active.filter(order => isOverdue(order, now)).length }
}
export function getWorkerWorkloads(users: User[], orders: Order[], now: DateValue = Date.now()): WorkerWorkload[] {
  return users.filter(user => user.role === 'worker').map(user => getWorkerWorkload(user, orders, now))
}

export const RATING_WEIGHTS = { quality: 40, onTime: 25, firstPass: 20, volume: 10, reasonableRejections: 5 } as const
export interface RatingComponents { quality: number; onTime: number; firstPass: number; volume: number; reasonableRejections: number }
export interface WorkerRating {
  user: User; userId: string; name: string; brigadeId: string | null; rank: number; score: number; evaluated: boolean
  closedCount: number; avgQuality: number; onTimePercent: number; firstPassPercent: number; complexity: number
  reworkCount: number; repeatFaultCount: number; rejectedCount: number; unreasonableRejections: number
  components: RatingComponents; weighted: RatingComponents; explanation: string
}
export function hadRework(order: Order): boolean { return order.events.some(event => event.toStatus === 'rework') || order.assessment?.verdict === 'rework' }
function faultOf(order: Order): string | undefined { return order.completion?.faultId || order.faultId }
/** A later unplanned occurrence flags the preceding repair, not its new assignee. */
export function repeatedRepairIds(orders: Order[]): Set<string> {
  const repeats = new Set<string>()
  const groups = new Map<string, Order[]>()
  for (const order of orders) {
    if (order.status === 'cancelled' || !faultOf(order)) continue
    const key = `${order.equipmentId}:${faultOf(order)}`
    groups.set(key, [...(groups.get(key) || []), order])
  }
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt))
    for (let i = 0; i < sorted.length; i += 1) {
      const repair = sorted[i], end = timestamp(completedTime(repair))
      if (!Number.isFinite(end)) continue
      if (sorted.slice(i + 1).some(next => next.type === 'unplanned' && timestamp(next.createdAt) >= end && timestamp(next.createdAt) - end <= 7 * DAY)) repeats.add(repair.id)
    }
  }
  return repeats
}

/** Range selects closed orders; recurrence searches all supplied history across the boundary. */
export function calculateRatings(orders: Order[], users: User[], filters: OrderFilters = {}): WorkerRating[] {
  const people = users.filter(user => user.role === 'worker' && (!filters.brigadeId || user.brigadeId === filters.brigadeId) && (!filters.assigneeId || user.id === filters.assigneeId))
  const repeats = repeatedRepairIds(orders)
  const periodOrders = filterOrders(orders, { ...filters, brigadeId: undefined, dateField: 'closedAt', status: 'closed' })
  // A rejection belongs to its event actor even after the work is reassigned.
  const rejectionOrders = filterOrders(orders, { ...filters, from: undefined, to: undefined, assigneeId: undefined, brigadeId: undefined, dateField: 'createdAt', status: '' })
  const values = people.map(user => {
    const own = periodOrders.filter(order => order.assigneeId === user.id)
    const scored = own.filter(order => order.assessment)
    const avgQuality = scored.length ? scored.reduce((sum, order) => sum + (order.assessment!.masterScore ?? order.assessment!.score), 0) / scored.length : 0
    const onTimePercent = own.length ? 100 * own.filter(isOnTime).length / own.length : 0
    const reworkCount = own.filter(hadRework).length, repeatFaultCount = own.filter(order => repeats.has(order.id)).length
    const firstPassPercent = own.length ? 100 * own.filter(order => !hadRework(order) && !repeats.has(order.id)).length / own.length : 0
    const rejected = rejectionOrders.flatMap(order => order.events.filter(event => event.toStatus === 'rejected' && event.actorId === user.id && isInRange(event.at, filters)))
    // Only plainly missing/frivolous reasons are penalized. Legitimate operational reasons remain neutral.
    const unreasonableRejections = rejected.filter(event => !event.comment.trim() || /^(не хочу|лень|не буду)[.!\s]*$/i.test(event.comment.trim())).length
    const complexity = own.reduce((sum, order) => sum + Math.max(0.5, Math.min(8, order.normHours || 1)) * (order.priority === 'emergency' ? 1.2 : 1), 0)
    return { user, own, avgQuality, onTimePercent, firstPassPercent, reworkCount, repeatFaultCount, rejectedCount: rejected.length, unreasonableRejections, complexity }
  })
  const maximumComplexity = Math.max(1, ...values.map(item => item.complexity))
  return values.map(value => {
    const evaluated = value.own.length > 0
    const components: RatingComponents = {
      quality: clamp(value.avgQuality / 5 * 100), onTime: value.onTimePercent, firstPass: value.firstPassPercent,
      volume: value.complexity / maximumComplexity * 100,
      reasonableRejections: value.rejectedCount ? (1 - value.unreasonableRejections / value.rejectedCount) * 100 : 100,
    }
    const weighted = Object.fromEntries(Object.entries(components).map(([key, amount]) => [key, round(amount * RATING_WEIGHTS[key as keyof RatingComponents] / 100)])) as unknown as RatingComponents
    const score = evaluated ? round(Object.values(weighted).reduce((sum, amount) => sum + amount, 0)) : 0
    return {
      user: value.user, userId: value.user.id, name: value.user.name, brigadeId: value.user.brigadeId, rank: 0, score, evaluated,
      closedCount: value.own.length, avgQuality: round(value.avgQuality, 2), onTimePercent: round(value.onTimePercent), firstPassPercent: round(value.firstPassPercent), complexity: round(value.complexity),
      reworkCount: value.reworkCount, repeatFaultCount: value.repeatFaultCount, rejectedCount: value.rejectedCount, unreasonableRejections: value.unreasonableRejections, components, weighted,
      explanation: evaluated ? `Качество ${weighted.quality}/40 + сроки ${weighted.onTime}/25 + без доработок и повторов ${weighted.firstPass}/20 + объём и сложность ${weighted.volume}/10 + обоснованные отказы ${weighted.reasonableRejections}/5. Закрыто ${value.own.length}; повторных неисправностей в течение 7 дней: ${value.repeatFaultCount}. Объём сравнивается с лидером выбранной группы.` : 'Нет закрытых нарядов за выбранный период — оценка пока не рассчитана.',
    }
  }).sort((a, b) => Number(b.evaluated) - Number(a.evaluated) || b.score - a.score || b.closedCount - a.closedCount || a.name.localeCompare(b.name, 'ru')).map((rating, index) => ({ ...rating, rank: index + 1 }))
}
export interface BrigadeRating { brigade: Brigade; score: number; closedCount: number; workerCount: number; onTimePercent: number; avgQuality: number; reworkCount: number; repeatFaultCount: number }
export function calculateBrigadeRatings(ratings: WorkerRating[], brigades: Brigade[]): BrigadeRating[] {
  return brigades.map(brigade => {
    const members = ratings.filter(rating => rating.brigadeId === brigade.id), count = members.reduce((sum, member) => sum + member.closedCount, 0)
    const average = (key: 'score' | 'onTimePercent' | 'avgQuality') => count ? round(members.reduce((sum, member) => sum + member[key] * member.closedCount, 0) / count) : 0
    return { brigade, score: average('score'), closedCount: count, workerCount: members.length, onTimePercent: average('onTimePercent'), avgQuality: average('avgQuality'), reworkCount: members.reduce((sum, member) => sum + member.reworkCount, 0), repeatFaultCount: members.reduce((sum, member) => sum + member.repeatFaultCount, 0) }
  }).sort((a, b) => b.score - a.score)
}

function unionHours(intervals: [number, number][]): number {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0])
  let total = 0, start = NaN, end = NaN
  for (const interval of sorted) {
    if (!Number.isFinite(start)) [start, end] = interval
    else if (interval[0] <= end) end = Math.max(end, interval[1])
    else { total += end - start; [start, end] = interval }
  }
  return round((total + (Number.isFinite(start) ? end - start : 0)) / HOUR)
}
export interface EquipmentStats {
  equipment: Equipment; orderCount: number; plannedCount: number; unplannedCount: number; activeCount: number
  downtimeHours: number; plannedDowntimeHours: number; unplannedDowntimeHours: number; repeatFaultCount: number
  avgRepairHours: number; estimated: true; faultCounts: { faultId: string; count: number }[]
}
/** Downtime is an estimate from work-order intervals, merged to avoid double counting. */
export function getEquipmentStats(orders: Order[], equipment: Equipment[], filters: OrderFilters = {}, now: DateValue = Date.now()): EquipmentStats[] {
  const selected = filterOrders(orders, filters), repeats = repeatedRepairIds(orders)
  // A repair issued before the period can still contribute downtime inside it.
  const intervalOrders = filterOrders(orders, { ...filters, from: undefined, to: undefined })
  return equipment.filter(item => (!filters.siteId || item.siteId === filters.siteId) && (!filters.equipmentId || item.id === filters.equipmentId)).map(item => {
    const own = selected.filter(order => order.equipmentId === item.id && order.status !== 'cancelled'), faults = new Map<string, number>()
    for (const order of own) { const fault = faultOf(order); if (fault) faults.set(fault, (faults.get(fault) || 0) + 1) }
    const intervals = (type?: 'planned' | 'unplanned'): [number, number][] => intervalOrders.filter(order => order.equipmentId === item.id && order.status !== 'cancelled' && (!type || order.type === type)).map(order => {
      const start = timestamp(order.type === 'planned' ? order.startedAt : order.createdAt)
      const end = timestamp(ACTIVE_STATUSES.includes(order.status) ? now : completedTime(order) || order.closedAt)
      return [Math.max(start, filters.from ? timestamp(filters.from) : -Infinity), Math.min(end, filters.to ? timestamp(filters.to) : Infinity)]
    })
    const completed = own.filter(order => order.startedAt && completedTime(order))
    return { equipment: item, orderCount: own.length, plannedCount: own.filter(order => order.type === 'planned').length, unplannedCount: own.filter(order => order.type === 'unplanned').length, activeCount: own.filter(order => ACTIVE_STATUSES.includes(order.status)).length,
      downtimeHours: unionHours(intervals()), plannedDowntimeHours: unionHours(intervals('planned')), unplannedDowntimeHours: unionHours(intervals('unplanned')),
      repeatFaultCount: own.filter(order => repeats.has(order.id)).length,
      avgRepairHours: completed.length ? round(completed.reduce((sum, order) => sum + durationHours(order.startedAt, completedTime(order)), 0) / completed.length) : 0,
      estimated: true as const, faultCounts: [...faults].map(([faultId, count]) => ({ faultId, count })).sort((a, b) => b.count - a.count),
    }
  }).sort((a, b) => b.unplannedCount - a.unplannedCount || b.downtimeHours - a.downtimeHours)
}

export interface MaterialStats { material: Material; quantity: number; orderCount: number; averageQuantity: number; expectedQuantity: number; excessQuantity: number; outlierCount: number; orderIds: string[] }
export function getMaterialStats(orders: Order[], materials: Material[], filters: OrderFilters = {}): MaterialStats[] {
  const selected = filterOrders(orders, filters).filter(order => order.status !== 'cancelled')
  return materials.map(material => {
    const usages = selected.flatMap(order => {
      const quantity = (order.completion?.materials || []).filter(usage => usage.materialId === material.id).reduce((sum, usage) => sum + usage.quantity, 0)
      return quantity > 0 ? [{ order, quantity }] : []
    })
    const quantity = usages.reduce((sum, usage) => sum + usage.quantity, 0), expectedQuantity = usages.length * material.normalQuantity
    return { material, quantity: round(quantity, 2), orderCount: usages.length, averageQuantity: usages.length ? round(quantity / usages.length, 2) : 0, expectedQuantity: round(expectedQuantity, 2), excessQuantity: round(Math.max(0, quantity - expectedQuantity), 2), outlierCount: usages.filter(usage => material.normalQuantity > 0 && usage.quantity > material.normalQuantity * 1.5).length, orderIds: usages.map(usage => usage.order.id) }
  }).filter(item => item.orderCount > 0).sort((a, b) => b.outlierCount - a.outlierCount || b.orderCount - a.orderCount)
}

export interface Anomaly {
  id: string
  type: 'repeat_fault' | 'frequency' | 'materials' | 'post_maintenance' | 'rework' | 'shift_dependency' | 'worker_dependency' | 'brigade_dependency' | 'failure_growth'
  severity: 'high' | 'medium'; title: string; description: string; recommendation: string; orderIds: string[]
  equipmentId?: string; userId?: string; brigadeId?: string; count: number
  evidence?: { currentCount: number; previousCount: number; windowDays: number; ratio: number }
}
/** Findings are deterministic evidence-based signals; correlation is not a proven cause. */
export function detectAnomalies(orders: Order[], catalogs: Catalogs, filters: OrderFilters = {}, now: DateValue = Date.now()): Anomaly[] {
  const selected = filterOrders(orders, filters, catalogs).filter(order => order.status !== 'cancelled'), findings: Anomaly[] = []
  const stats = getEquipmentStats(orders, catalogs.equipment, filters)
  const counts = stats.map(item => item.unplannedCount).sort((a, b) => a - b)
  const baseline = counts.length ? counts[Math.floor(counts.length / 2)] : 0
  for (const item of stats) {
    if (baseline > 0 && item.unplannedCount >= Math.max(5, baseline * 2.5)) findings.push({ id: `frequency-${item.equipment.id}`, type: 'frequency', severity: 'high', title: `${item.equipment.name}: частые остановки`, description: `${item.unplannedCount} внеплановых нарядов — в ${round(item.unplannedCount / baseline)} раза выше медианы оборудования (${baseline}) за выбранный период. Расчётный простой: ${item.downtimeHours} ч.`, recommendation: 'Провести диагностику узла и пересмотреть интервалы обслуживания; сопоставить остановки с журналом эксплуатации.', orderIds: selected.filter(order => order.equipmentId === item.equipment.id && order.type === 'unplanned').map(order => order.id), equipmentId: item.equipment.id, count: item.unplannedCount })
    for (const fault of item.faultCounts) {
      const matching = selected.filter(order => order.equipmentId === item.equipment.id && order.type === 'unplanned' && faultOf(order) === fault.faultId)
      if (matching.length < 3) continue
      const reference = catalogs.faults.find(value => value.id === fault.faultId)
      findings.push({ id: `repeat-${item.equipment.id}-${fault.faultId}`, type: 'repeat_fault', severity: matching.length >= 5 ? 'high' : 'medium', title: `${item.equipment.name}: повторяется ${reference?.code || 'неисправность'}`, description: `${matching.length} внеплановых нарядов с одной неисправностью${reference ? ` «${reference.name}»` : ''}. Возможен неустранённый первичный дефект.`, recommendation: /подшип|М-02/i.test(`${reference?.name} ${reference?.code}`) ? 'Проверить соосность привода, вибрацию и смазку; включить диагностику подшипников в ППР.' : 'Проверить первопричину, условия эксплуатации и результат предыдущих ремонтов; скорректировать план ППР.', orderIds: matching.map(order => order.id), equipmentId: item.equipment.id, count: matching.length })
    }
  }
  for (const material of getMaterialStats(orders, catalogs.materials, filters)) {
    if (material.outlierCount < 2) continue
    const ids = selected.filter(order => (order.completion?.materials || []).filter(usage => usage.materialId === material.material.id).reduce((sum, usage) => sum + usage.quantity, 0) > material.material.normalQuantity * 1.5).map(order => order.id)
    findings.push({ id: `material-${material.material.id}`, type: 'materials', severity: material.outlierCount >= 5 ? 'high' : 'medium', title: `${material.material.name}: повышенный расход`, description: `В ${material.outlierCount} нарядах расход выше справочного норматива более чем на 50%. Среднее: ${material.averageQuantity} ${material.material.unit}, норматив: ${material.material.normalQuantity} ${material.material.unit} на работу.`, recommendation: 'Сверить списания со складом, объём работ и применимость норматива; проверить возможные утечки и повторные замены.', orderIds: ids, count: material.outlierCount })
  }
  for (const item of catalogs.equipment) {
    const maintenance = orders.filter(order => order.equipmentId === item.id && order.type === 'planned' && completedTime(order) && order.status !== 'cancelled')
    const failures = selected.filter(order => order.equipmentId === item.id && order.type === 'unplanned' && maintenance.some(previous => timestamp(order.createdAt) >= timestamp(completedTime(previous)) && timestamp(order.createdAt) - timestamp(completedTime(previous)) <= 7 * DAY))
    if (failures.length >= 2) findings.push({ id: `maintenance-${item.id}`, type: 'post_maintenance', severity: 'high', title: `${item.name}: отказы после ППР`, description: `${failures.length} внеплановых нарядов возникли в течение 7 дней после планового обслуживания. Связь во времени требует проверки, причина пока не установлена.`, recommendation: 'Проверить чек-лист ППР, приёмку после ремонта и качество установленных деталей.', orderIds: failures.map(order => order.id), equipmentId: item.id, count: failures.length })
  }
  for (const user of catalogs.users.filter(value => value.role === 'worker')) {
    const own = selected.filter(order => order.assigneeId === user.id && (order.status === 'closed' || order.assessment)), reworks = own.filter(hadRework)
    if (own.length >= 5 && reworks.length >= 3 && reworks.length / own.length >= 0.25) findings.push({ id: `rework-${user.id}`, type: 'rework', severity: 'medium', title: `${user.name}: частые доработки`, description: `${reworks.length} из ${own.length} проверенных нарядов (${Math.round(100 * reworks.length / own.length)}%) возвращались на доработку. Учитывайте сложность работ перед оценкой сотрудника.`, recommendation: 'Разобрать причины возвратов с мастером, проверить инструкции, доступность материалов и необходимость наставничества.', orderIds: reworks.map(order => order.id), userId: user.id, count: reworks.length })
  }
  findings.push(...detectDependencies(orders, selected, catalogs, now), ...detectFailureGrowth(orders, catalogs, filters, now))
  return findings.sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1) || b.count - a.count)
}

/** Compare proportions, not raw assignment counts. Small groups never produce a personnel finding. */
function detectDependencies(allOrders: Order[], selected: Order[], catalogs: Catalogs, now: DateValue): Anomaly[] {
  const findings: Anomaly[] = []
  const groups = [true, false].map(isDay => {
    const own = selected.filter(order => { const time = timestamp(order.createdAt); if (!Number.isFinite(time)) return false; const hour = localParts(time).hour; return (hour >= 8 && hour < 20) === isDay })
    return { isDay, own, failures: own.filter(order => order.type === 'unplanned') }
  })
  for (const [index, group] of groups.entries()) {
    const peer = groups[1 - index], rate = group.failures.length / group.own.length, peerRate = peer.failures.length / peer.own.length
    if (group.own.length < 8 || peer.own.length < 8 || group.failures.length < 5 || rate - peerRate < 0.3 || rate < peerRate * 1.7) continue
    const shift = group.isDay ? 'Дневная смена' : 'Ночная смена'
    findings.push({ id: `shift-${group.isDay ? 'day' : 'night'}`, type: 'shift_dependency', severity: 'medium', title: `${shift}: выше доля внеплановых работ`,
      description: `${group.failures.length} из ${group.own.length} выданных нарядов (${Math.round(rate * 100)}%) — внеплановые; в другой смене ${peer.failures.length} из ${peer.own.length} (${Math.round(peerRate * 100)}%). Группа определяется по времени выдачи в ${TIME_ZONE}; это связь в заявках, а не установленное время поломки или её причина.`,
      recommendation: 'Сопоставить режим нагрузки и состав оборудования смен, время обнаружения дефектов и записи передачи смены. Проверить первопричины до изменения регламента.',
      orderIds: [...group.own, ...peer.own].map(order => order.id), count: group.failures.length })
  }

  const repeats = repeatedRepairIds(allOrders)
  // Every compared repair has the same complete seven-day observation window.
  const mature = selected.filter(order => order.status === 'closed' && timestamp(completedTime(order)) <= timestamp(now) - 7 * DAY)
  const problematic = (order: Order) => hadRework(order) || repeats.has(order.id)
  const compare = (id: string, name: string, kind: 'worker' | 'brigade', matches: (order: Order) => boolean) => {
    const own = mature.filter(matches), peers = mature.filter(order => !matches(order))
    const affected = own.filter(problematic), peerAffected = peers.filter(problematic)
    const rate = affected.length / own.length, peerRate = peerAffected.length / peers.length
    if (own.length < 8 || peers.length < 8 || affected.length < 4 || rate < 0.35 || rate - peerRate < 0.2 || rate < peerRate * 1.7) return
    findings.push({ id: `dependency-${kind}-${id}`, type: kind === 'worker' ? 'worker_dependency' : 'brigade_dependency', severity: 'medium', title: `${name}: связь с повторными работами`,
      description: `В ${affected.length} из ${own.length} закрытых ремонтов (${Math.round(rate * 100)}%) была доработка или тот же дефект в следующие 7 дней; в остальной выбранной группе — ${peerAffected.length} из ${peers.length} (${Math.round(peerRate * 100)}%). Учтены только ремонты с полными 7 днями наблюдения. Связь не доказывает вину исполнителя или бригады.`,
      recommendation: 'Сравнить одинаковые типы оборудования и сложность заданий; проверить качество деталей, инструкции и допуски. Разобрать причины вместе с мастером, без автоматических взысканий.',
      orderIds: [...own, ...peers].map(order => order.id), count: affected.length, ...(kind === 'worker' ? { userId: id } : { brigadeId: id }) })
  }
  for (const user of catalogs.users.filter(user => user.role === 'worker')) compare(user.id, user.name, 'worker', order => order.assigneeId === user.id)
  for (const brigade of catalogs.brigades) compare(brigade.id, brigade.name, 'brigade', order => (order.brigadeId || catalogs.users.find(user => user.id === order.assigneeId)?.brigadeId) === brigade.id)
  return findings
}

/** Early warning only: two equal recent windows, with at least seven days in each. No failure probability is inferred. */
function detectFailureGrowth(orders: Order[], catalogs: Catalogs, filters: OrderFilters, now: DateValue): Anomaly[] {
  const end = Math.min(filters.to ? timestamp(filters.to) : timestamp(now), timestamp(now))
  const span = filters.from ? end - timestamp(filters.from) : 28 * DAY
  const window = Math.min(14 * DAY, span / 2)
  if (!Number.isFinite(window) || window < 7 * DAY) return []
  const middle = end - window, start = middle - window
  const selected = filterOrders(orders, { ...filters, from: new Date(start), to: new Date(end), dateField: 'createdAt' }, catalogs, now)
    .filter(order => order.type === 'unplanned' && order.status !== 'cancelled')
  const findings: Anomaly[] = []
  for (const equipment of catalogs.equipment) {
    const own = selected.filter(order => order.equipmentId === equipment.id)
    const previous = own.filter(order => timestamp(order.createdAt) < middle), current = own.filter(order => timestamp(order.createdAt) >= middle)
    const days = (rows: Order[]) => new Set(rows.map(order => { const p = localParts(order.createdAt); return `${p.year}-${p.month}-${p.day}` })).size
    if (previous.length < 2 || current.length < 5 || current.length - previous.length < 3 || current.length / previous.length < 2.5 || days(previous) < 2 || days(current) < 3) continue
    const ratio = round(current.length / previous.length), windowDays = round(window / DAY, 1)
    findings.push({ id: `growth-${equipment.id}`, type: 'failure_growth', severity: 'high', title: `${equipment.name}: растёт частота внеплановых работ`,
      description: `За последние ${windowDays} дней — ${current.length} внеплановых нарядов, за предыдущие равные ${windowDays} дней — ${previous.length}; рост в ${ratio} раза. Сравнение: ${formatDate(start)}–${formatDate(middle)} и ${formatDate(middle)}–${formatDate(end)} (правая граница не включается). Это ранний сигнал риска по заявкам, а не рассчитанная вероятность или дата отказа.`,
      recommendation: 'Назначить диагностику до следующей смены, проверить повторяющиеся дефекты и запас критичных деталей; сопоставить рост с наработкой и изменениями режима эксплуатации.',
      orderIds: own.map(order => order.id), equipmentId: equipment.id, count: current.length,
      evidence: { currentCount: current.length, previousCount: previous.length, windowDays, ratio } })
  }
  return findings
}

export interface OrderTrendPoint { key: string; label: string; total: number; planned: number; unplanned: number; closed: number; overdue: number }
export function getOrderTrend(orders: Order[], range: DateRange = {}, granularity: 'day' | 'month' = 'day', now: DateValue = Date.now()): OrderTrendPoint[] {
  const selected = filterOrders(orders, range), result = new Map<string, OrderTrendPoint>()
  const keyOf = (date: DateValue) => { const p = localParts(date); return `${p.year}-${String(p.month).padStart(2, '0')}${granularity === 'day' ? `-${String(p.day).padStart(2, '0')}` : ''}` }
  const addBucket = (date: DateValue) => {
    const key = keyOf(date)
    if (!result.has(key)) result.set(key, { key, label: formatDate(date, granularity === 'month' ? { day: undefined, month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short' }), total: 0, planned: 0, unplanned: 0, closed: 0, overdue: 0 })
    return result.get(key)!
  }
  const start = range.from ? timestamp(range.from) : Math.min(...selected.map(order => timestamp(order.createdAt)))
  const end = range.to ? timestamp(range.to) : timestamp(now)
  if (Number.isFinite(start) && Number.isFinite(end)) {
    for (let time = start, loops = 0; time < end && loops < 1_100; time += DAY, loops += 1) addBucket(time)
  }
  for (const order of selected) { const bucket = addBucket(order.createdAt); bucket.total += 1; bucket[order.type] += 1; if (order.status === 'closed') bucket.closed += 1; if (isOverdue(order, now)) bucket.overdue += 1 }
  return [...result.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export interface DashboardStats { issued: number; completed: number; closed: number; overdue: number; active: number; inProgress: number; awaitingReview: number; rejected: number; downtimeEquipment: number; freeWorkers: number; onShiftWorkers: number; averageScore: number; onTimePercent: number }
/** Apply scope once; each event count uses its own timestamp, including carried-over work. */
export function getDashboardStats(orders: Order[], users: User[], range: OrderFilters = getShiftRange(), now: DateValue = Date.now()): DashboardStats {
  const selected = filterOrders(orders, { ...range, from: undefined, to: undefined, brigadeId: undefined }, undefined, now)
    .filter(order => !range.brigadeId || (order.brigadeId || users.find(user => user.id === order.assigneeId)?.brigadeId) === range.brigadeId)
  const people = users.filter(user => (!range.assigneeId || user.id === range.assigneeId) && (!range.brigadeId || user.brigadeId === range.brigadeId))
  const active = selected.filter(order => ACTIVE_STATUSES.includes(order.status)), issued = selected.filter(order => isInRange(order.createdAt, range)), completed = selected.filter(order => isInRange(completedTime(order), range)), reviewed = completed.filter(order => order.assessment), workload = getWorkerWorkloads(people, orders, now)
  return { issued: issued.length, completed: completed.length, closed: selected.filter(order => order.status === 'closed' && isInRange(order.closedAt, range)).length, overdue: active.filter(order => isOverdue(order, now)).length, active: active.length, inProgress: active.filter(order => order.status === 'in_progress').length, awaitingReview: selected.filter(order => order.status === 'ai_review').length, rejected: selected.filter(order => order.events.some(event => event.toStatus === 'rejected' && isInRange(event.at, range))).length, downtimeEquipment: new Set(active.filter(order => order.type === 'unplanned').map(order => order.equipmentId)).size, freeWorkers: workload.filter(worker => worker.status === 'free').length, onShiftWorkers: workload.filter(worker => worker.user.onShift).length, averageScore: reviewed.length ? round(reviewed.reduce((sum, order) => sum + (order.assessment!.masterScore ?? order.assessment!.score), 0) / reviewed.length, 2) : 0, onTimePercent: completed.length ? round(completed.filter(isOnTime).length / completed.length * 100) : 0 }
}
export interface ManagementStats {
  avgReactionMinutes: number | null; avgExecutionHours: number | null; reactionSampleCount: number; executionSampleCount: number
  downtimeHours: number; topEquipment: EquipmentStats[]; topWorkers: WorkerRating[]
}
/** Reaction is issue to first worker response; execution is start to submission, including pauses. */
export function getManagementStats(orders: Order[], catalogs: Catalogs, filters: OrderFilters = {}, now: DateValue = Date.now()): ManagementStats {
  const normalized = orders.map(order => order.brigadeId ? order : { ...order, brigadeId: catalogs.users.find(user => user.id === order.assigneeId)?.brigadeId || undefined })
  const scope = filterOrders(normalized, { ...filters, from: undefined, to: undefined }, catalogs, now).filter(order => order.status !== 'cancelled')
  const reaction: number[] = [], execution: number[] = []
  for (const order of scope) {
    const response = [...order.events].filter(event => event.toStatus && ['accepted', 'queued', 'rejected', 'in_progress'].includes(event.toStatus))
      .map(event => timestamp(event.at)).filter(time => time >= timestamp(order.createdAt) && time <= timestamp(now)).sort((a, b) => a - b)[0]
    const respondedAt = Number.isFinite(response) ? response : timestamp(order.startedAt)
    if (isInRange(order.createdAt, filters) && respondedAt >= timestamp(order.createdAt) && respondedAt <= timestamp(now)) reaction.push((respondedAt - timestamp(order.createdAt)) / MINUTE)
    const completed = completedTime(order), started = timestamp(order.startedAt)
    if (!ACTIVE_STATUSES.includes(order.status) && order.status !== 'rejected' && isInRange(completed, filters) && timestamp(completed) >= started && timestamp(completed) <= timestamp(now)) execution.push((timestamp(completed) - started) / HOUR)
  }
  const equipment = getEquipmentStats(normalized, catalogs.equipment || [], filters, now)
  return { avgReactionMinutes: reaction.length ? round(reaction.reduce((sum, value) => sum + value, 0) / reaction.length) : null,
    avgExecutionHours: execution.length ? round(execution.reduce((sum, value) => sum + value, 0) / execution.length, 2) : null,
    reactionSampleCount: reaction.length, executionSampleCount: execution.length,
    downtimeHours: round(equipment.reduce((sum, item) => sum + item.downtimeHours, 0)),
    topEquipment: equipment.filter(item => item.orderCount || item.downtimeHours).slice(0, 5),
    topWorkers: calculateRatings(normalized, catalogs.users, filters).filter(item => item.evaluated).slice(0, 5) }
}

export function buildShiftSummary(orders: Order[], catalogs: Catalogs, range: OrderFilters = getShiftRange(), now: DateValue = Date.now()): string {
  const stats = getDashboardStats(orders, catalogs.users, range, now)
  const management = getManagementStats(orders, catalogs, range, now)
  const timing = [management.avgReactionMinutes === null ? '' : `Средняя реакция на выданные за период наряды: ${management.avgReactionMinutes} мин (${management.reactionSampleCount} с ответом).`, management.avgExecutionHours === null ? '' : `Среднее исполнение: ${formatDuration(management.avgExecutionHours)}, включая паузы (${management.executionSampleCount} отчётов).`].filter(Boolean).join(' ')
  return `За выбранный период выдано ${stats.issued} нарядов, исполнено ${stats.completed}, закрыто мастером ${stats.closed}. Отклонено исполнителями: ${stats.rejected}. Сейчас в работе ${stats.inProgress}, ожидают проверки ${stats.awaitingReview}, просрочено ${stats.overdue}. Свободных исполнителей на смене: ${stats.freeWorkers} из ${stats.onShiftWorkers}; заняты или имеют очередь: ${stats.onShiftWorkers - stats.freeWorkers}. В срок исполнено ${stats.onTimePercent}%. Расчётный простой оборудования за период: ${formatDuration(management.downtimeHours)}. ${timing}${timing ? ' ' : ''}${stats.overdue ? 'Рекомендуется уточнить причины просрочки и перераспределить срочные работы с учётом допуска и специальности.' : 'Активных просрочек нет; контролируйте ближайшие сроки и приёмку выполненных работ.'}`
}
