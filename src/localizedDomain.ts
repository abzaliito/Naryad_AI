/** Presentation-only localization. The shared domain module remains locale-independent for the API. */
import * as domain from './domain.ts'
import { getLocale, t } from './i18n.ts'
import type { Catalogs, Order, OrderFilters } from './types'
export * from './domain.ts'

type DateValue = Parameters<typeof domain.formatDate>[0]
const timestamp = (value: DateValue) => value == null ? NaN : new Date(value).getTime()
const DAY = 86400000

export function formatDate(value: DateValue, options: Intl.DateTimeFormatOptions = {}): string {
  if (getLocale() === 'ru') return domain.formatDate(value, options)
  const ms = timestamp(value)
  return Number.isFinite(ms) ? new Intl.DateTimeFormat('kk-KZ', { day: '2-digit', month: 'short', timeZone: domain.TIME_ZONE, ...options }).format(ms) : '—'
}
export function formatTime(value: DateValue): string {
  return getLocale() === 'ru' ? domain.formatTime(value) : formatDate(value, { day: undefined, month: undefined, hour: '2-digit', minute: '2-digit' })
}
export function formatDateTime(value: DateValue): string {
  return getLocale() === 'ru' ? domain.formatDateTime(value) : formatDate(value, { hour: '2-digit', minute: '2-digit' })
}
export function formatDuration(hours: number): string {
  if (getLocale() === 'ru') return domain.formatDuration(hours)
  const minutes = Math.max(0, Math.round(hours * 60))
  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} сағ${minutes % 60 ? ` ${minutes % 60} мин` : ''}`
}
export function relativeTime(value: DateValue, now: DateValue = Date.now()): string {
  if (getLocale() === 'ru') return domain.relativeTime(value, now)
  const delta = timestamp(value) - timestamp(now)
  if (!Number.isFinite(delta)) return '—'
  if (Math.abs(delta) < 60000) return 'қазір'
  const formatter = new Intl.RelativeTimeFormat('kk', { numeric: 'auto' })
  return Math.abs(delta) < 3600000 ? formatter.format(Math.round(delta / 60000), 'minute') : Math.abs(delta) < DAY ? formatter.format(Math.round(delta / 3600000), 'hour') : formatter.format(Math.round(delta / DAY), 'day')
}

function localizedWorkload(row: domain.WorkerWorkload): domain.WorkerWorkload {
  if (getLocale() === 'ru') return row
  const occupied = row.active.find(order => order.status === 'accepted' || order.status === 'rework')
  const label = !row.user.onShift ? t('Не на смене') : row.current ? `${t(row.current.status === 'paused' ? 'Приостановлен' : 'В работе')} №${row.current.number}` : occupied ? `Қабылданды №${occupied.number}` : row.queueCount ? `Кезекте: ${row.queueCount}` : t('Свободен')
  return { ...row, label }
}
export function getWorkerWorkload(...args: Parameters<typeof domain.getWorkerWorkload>): domain.WorkerWorkload {
  return localizedWorkload(domain.getWorkerWorkload(...args))
}
export function getWorkerWorkloads(...args: Parameters<typeof domain.getWorkerWorkloads>): domain.WorkerWorkload[] {
  return domain.getWorkerWorkloads(...args).map(localizedWorkload)
}
export function getShiftRange(...args: Parameters<typeof domain.getShiftRange>): ReturnType<typeof domain.getShiftRange> {
  const result = domain.getShiftRange(...args)
  return getLocale() === 'ru' ? result : { ...result, label: result.isDay ? 'Күндізгі ауысым · 08:00–20:00' : 'Түнгі ауысым · 20:00–08:00' }
}
export function getPeriodRange(...args: Parameters<typeof domain.getPeriodRange>): ReturnType<typeof domain.getPeriodRange> {
  return args[0] === 'shift' ? getShiftRange(args[1]) : domain.getPeriodRange(...args)
}
export function getOrderTrend(...args: Parameters<typeof domain.getOrderTrend>): domain.OrderTrendPoint[] {
  const rows = domain.getOrderTrend(...args)
  if (getLocale() === 'ru') return rows
  return rows.map(row => ({ ...row, label: formatDate(`${row.key.length === 7 ? `${row.key}-01` : row.key}T12:00:00+05:00`, args[2] === 'month' ? { day: undefined, month: 'short', year: 'numeric' } : { day: '2-digit', month: 'short' }) }))
}

function localizedRating(row: domain.WorkerRating): domain.WorkerRating {
  if (getLocale() === 'ru') return row
  const w = row.weighted
  return { ...row, explanation: row.evaluated
    ? `Сапа ${w.quality}/40 + мерзім ${w.onTime}/25 + түзетусіз және қайталанусыз ${w.firstPass}/20 + көлемі мен күрделілігі ${w.volume}/10 + негізді бас тартулар ${w.reasonableRejections}/5. Жабылғаны: ${row.closedCount}; 7 күн ішінде қайталанған ақаулар: ${row.repeatFaultCount}. Жұмыс көлемі таңдалған топтың көшбасшысымен салыстырылады.`
    : 'Таңдалған кезеңде жабылған нарядтар жоқ — баға әлі есептелмеген.' }
}
export function calculateRatings(...args: Parameters<typeof domain.calculateRatings>): domain.WorkerRating[] {
  return domain.calculateRatings(...args).map(localizedRating)
}
export function getManagementStats(...args: Parameters<typeof domain.getManagementStats>): domain.ManagementStats {
  const result = domain.getManagementStats(...args)
  return getLocale() === 'ru' ? result : { ...result, topWorkers: result.topWorkers.map(localizedRating) }
}
export function buildShiftSummary(orders: Order[], catalogs: Catalogs, range: OrderFilters = domain.getShiftRange(), now: DateValue = Date.now()): string {
  if (getLocale() === 'ru') return domain.buildShiftSummary(orders, catalogs, range, now)
  const stats = domain.getDashboardStats(orders, catalogs.users, range, now)
  const management = domain.getManagementStats(orders, catalogs, range, now)
  const timing = [management.avgReactionMinutes === null ? '' : `Осы кезеңде берілген нарядтарға орташа жауап беру уақыты: ${management.avgReactionMinutes} мин (жауап берілгені: ${management.reactionSampleCount}).`, management.avgExecutionHours === null ? '' : `Орташа орындау уақыты: ${formatDuration(management.avgExecutionHours)}, үзілістерді қоса алғанда (${management.executionSampleCount} есеп).`].filter(Boolean).join(' ')
  return `Таңдалған кезеңде ${stats.issued} наряд берілді, ${stats.completed} наряд орындалды, шебер ${stats.closed} нарядты жапты. Орындаушылар қабылдамағаны: ${stats.rejected}. Қазір ${stats.inProgress} наряд орындалуда, ${stats.awaitingReview} наряд тексеруді күтуде, ${stats.overdue} нарядтың мерзімі өткен. Ауысымдағы ${stats.onShiftWorkers} орындаушының ${stats.freeWorkers} бос; жұмыста немесе кезекте: ${stats.onShiftWorkers - stats.freeWorkers}. Уақытында орындалғаны: ${stats.onTimePercent}%. Осы кезеңдегі жабдықтың есептік тоқтау уақыты: ${formatDuration(management.downtimeHours)}. ${timing}${timing ? ' ' : ''}${stats.overdue ? 'Кешігу себептерін нақтылап, шұғыл жұмысты мамандық пен жұмысқа жіберілуін ескере отырып қайта бөлуді ұсынамыз.' : 'Белсенді нарядтар арасында мерзімі өткендер жоқ; жақын мерзімдерді және орындалған жұмысты қабылдауды бақылаңыз.'}`
}

/** Translate generated narrative only; identifiers, evidence, catalog names and free text stay intact. */
export function localizeAnomaly(finding: domain.Anomaly, orders: Order[], catalogs: Catalogs, filters: OrderFilters = {}, now: DateValue = Date.now()): domain.Anomaly {
  if (getLocale() === 'ru') return finding
  const equipment = catalogs.equipment.find(item => item.id === finding.equipmentId)
  const user = catalogs.users.find(item => item.id === finding.userId)
  const brigade = catalogs.brigades.find(item => item.id === finding.brigadeId)
  const equipmentName = equipment?.name ?? 'Жабдық'
  let title = finding.title, description = finding.description, recommendation = finding.recommendation
  switch (finding.type) {
    case 'frequency': {
      const numbers = finding.description.match(/^(\d+) внеплановых нарядов — в ([\d.]+) раза выше медианы оборудования \(([\d.]+)\) за выбранный период\. Расчётный простой: ([\d.]+) ч\./)
      title = `${equipmentName}: жиі тоқтайды`
      if (numbers) description = `${numbers[1]} жоспардан тыс наряд — таңдалған кезеңдегі жабдық медианасынан (${numbers[3]}) ${numbers[2]} есе жоғары. Есептік тоқтау уақыты: ${numbers[4]} сағ.`
      recommendation = 'Торапты диагностикалап, қызмет көрсету аралықтарын қайта қараңыз; тоқтауларды пайдалану журналымен салыстырыңыз.'
      break
    }
    case 'repeat_fault': {
      const sample = orders.find(order => finding.orderIds.includes(order.id))
      const fault = catalogs.faults.find(item => item.id === (sample?.completion?.faultId || sample?.faultId))
      title = `${equipmentName}: ${fault?.code || 'ақау'} қайталанады`
      description = `${finding.count} жоспардан тыс нарядта бірдей ақау${fault ? ` «${fault.name}»` : ''} анықталған. Бастапқы ақау жойылмаған болуы мүмкін.`
      recommendation = /подшип|М-02/i.test(`${fault?.name} ${fault?.code}`)
        ? 'Жетектің осьтестігін, дірілін және майлануын тексеріңіз; мойынтіректер диагностикасын жоспарлы жөндеуге қосыңыз.'
        : 'Түпкі себепті, пайдалану жағдайын және алдыңғы жөндеулердің нәтижесін тексеріңіз; жоспарлы жөндеу жоспарын түзетіңіз.'
      break
    }
    case 'materials': {
      const material = catalogs.materials.find(item => `material-${item.id}` === finding.id)
      const usage = material && domain.getMaterialStats(orders, catalogs.materials, filters).find(item => item.material.id === material.id)
      title = `${material?.name ?? 'Материал'}: шығын жоғары`
      if (material && usage) description = `${finding.count} нарядта шығын анықтамалық нормативтен 50%-дан артық. Орташа шығын: ${usage.averageQuantity} ${material.unit}, бір жұмысқа норматив: ${material.normalQuantity} ${material.unit}.`
      recommendation = 'Есептен шығаруды қойма деректерімен, жұмыс көлемімен және нормативтің сәйкестігімен салыстырыңыз; ықтимал ағулар мен қайталама ауыстыруларды тексеріңіз.'
      break
    }
    case 'post_maintenance':
      title = `${equipmentName}: жоспарлы жөндеуден кейінгі ақаулар`
      description = `${finding.count} жоспардан тыс наряд жоспарлы қызмет көрсетуден кейінгі 7 күн ішінде пайда болған. Уақыт бойынша байланыс тексеруді қажет етеді, себеп әлі анықталмаған.`
      recommendation = 'Жоспарлы қызмет көрсету тізімін, жөндеуден кейінгі қабылдауды және орнатылған бөлшектердің сапасын тексеріңіз.'
      break
    case 'rework': {
      const numbers = finding.description.match(/^(\d+) из (\d+) проверенных нарядов \((\d+)%\)/)
      title = `${user?.name ?? 'Орындаушы'}: жиі түзетуге қайтарылады`
      if (numbers) description = `Тексерілген ${numbers[2]} нарядтың ${numbers[1]} наряды (${numbers[3]}%) түзетуге қайтарылған. Қызметкерді бағалағанда жұмыстың күрделілігін ескеріңіз.`
      recommendation = 'Қайтару себептерін шебермен талқылаңыз; нұсқаулықтарды, материалдардың қолжетімділігін және тәлімгерлік қажеттілігін тексеріңіз.'
      break
    }
    case 'shift_dependency': {
      const numbers = finding.description.match(/^(\d+) из (\d+) выданных нарядов \((\d+)%\).*?; в другой смене (\d+) из (\d+) \((\d+)%\)/)
      title = `${finding.id === 'shift-day' ? 'Күндізгі ауысым' : 'Түнгі ауысым'}: жоспардан тыс жұмыстың үлесі жоғары`
      if (numbers) description = `Берілген ${numbers[2]} нарядтың ${numbers[1]} наряды (${numbers[3]}%) жоспардан тыс; басқа ауысымда ${numbers[5]} нарядтың ${numbers[4]} наряды (${numbers[6]}%). Топ ${domain.TIME_ZONE} бойынша наряд беру уақытымен анықталады; бұл өтінімдердегі байланыс, ақаудың анықталған уақыты немесе себебі емес.`
      recommendation = 'Ауысымдардың жүктеме режимін, жабдық құрамын, ақау анықталған уақытты және ауысымды тапсыру жазбаларын салыстырыңыз. Регламентті өзгертпес бұрын түпкі себептерді тексеріңіз.'
      break
    }
    case 'worker_dependency':
    case 'brigade_dependency': {
      const numbers = finding.description.match(/^В (\d+) из (\d+) закрытых ремонтов \((\d+)%\).*?следующие 7 дней; в остальной выбранной группе — (\d+) из (\d+) \((\d+)%\)/)
      title = `${finding.type === 'worker_dependency' ? user?.name ?? 'Орындаушы' : brigade?.name ?? 'Бригада'}: қайталама жұмыстармен байланыс`
      if (numbers) description = `Жабылған ${numbers[2]} жөндеудің ${numbers[1]} жөндеуінде (${numbers[3]}%) түзету немесе кейінгі 7 күнде сол ақаудың қайталануы болған; таңдалған топтың қалған бөлігінде ${numbers[5]} жөндеудің ${numbers[4]} жөндеуінде (${numbers[6]}%). Тек толық 7 күн бақыланған жөндеулер есепке алынды. Байланыс орындаушының немесе бригаданың кінәсін дәлелдемейді.`
      recommendation = 'Бірдей жабдық түрлері мен тапсырма күрделілігін салыстырыңыз; бөлшек сапасын, нұсқаулықтарды және жұмысқа жіберілуін тексеріңіз. Себептерді шебермен бірге талқылаңыз, автоматты жаза қолданбаңыз.'
      break
    }
    case 'failure_growth': {
      const evidence = finding.evidence
      title = `${equipmentName}: жоспардан тыс жұмыстар жиілеп келеді`
      if (evidence) {
        const end = Math.min(filters.to ? timestamp(filters.to) : timestamp(now), timestamp(now))
        const span = filters.from ? end - timestamp(filters.from) : 28 * DAY
        const window = Math.min(14 * DAY, span / 2), middle = end - window, start = middle - window
        description = `Соңғы ${evidence.windowDays} күнде ${evidence.currentCount} жоспардан тыс наряд, ал алдыңғы дәл сондай ${evidence.windowDays} күнде ${evidence.previousCount} наряд болған; өсім ${evidence.ratio} есе. Салыстыру: ${formatDate(start)}–${formatDate(middle)} және ${formatDate(middle)}–${formatDate(end)} (оң жақ шекара кірмейді). Бұл өтінімдер бойынша тәуекелдің ерте белгісі, ақаудың есептелген ықтималдығы немесе күні емес.`
      }
      recommendation = 'Келесі ауысымға дейін диагностика тағайындаңыз, қайталанатын ақауларды және маңызды бөлшектер қорын тексеріңіз; өсімді жұмыс сағаттарымен және пайдалану режимінің өзгеруімен салыстырыңыз.'
      break
    }
  }
  return { ...finding, title, description, recommendation }
}
export function detectAnomalies(orders: Order[], catalogs: Catalogs, filters: OrderFilters = {}, now: DateValue = Date.now()): domain.Anomaly[] {
  return domain.detectAnomalies(orders, catalogs, filters, now).map(finding => localizeAnomaly(finding, orders, catalogs, filters, now))
}
