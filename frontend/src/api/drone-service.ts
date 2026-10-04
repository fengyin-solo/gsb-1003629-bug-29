import { listRows, saveRows, seedRowsOf } from '@/data/local-store'
import { droneDomain, resetDroneDomain, saveDroneDomain } from '@/data/drone-store'
import type {
  CheckReminder,
  DronePilot,
  DroneSortie,
  DroneStats,
  StoredSegment,
  UploadTrackInput,
  UploadTrackResult,
} from '@/data/drone-types'
import type { ActionResult, EntryRow } from '@/data/types'

const DRONE_KEY = 'drone'
const REPORT_KEY = 'firereport'
const TASK_STATUSES = ['待执行', '飞行中', '已完成', '因故中止']
const CLOSED_STATUS = ['已完成', '因故中止']
// 网络耗时（模拟）：上传是异步过程，期间第二次并发提交必须被拒绝。
const UPLOAD_LATENCY_MS = 500

// 模块级提交锁：同一时刻只允许一个航迹上传事务在途。
let uploadInFlight = false

function now(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function todayStr(): string {
  return now().slice(0, 10)
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function fail(message: string, sortieNo: string, received: number[] = []): UploadTrackResult {
  return {
    ok: false,
    message,
    架次编号: sortieNo,
    本批接收: [],
    已接收段: received,
    缺失段: missingSeqs(received, 0),
    异常数: 0,
    任务状态: '',
    生成报告: '',
    生成提醒: '',
  }
}

function missingSeqs(received: number[], total: number): number[] {
  const owned = new Set(received)
  const result: number[] = []
  for (let seq = 1; seq <= total; seq += 1) {
    if (!owned.has(seq)) {
      result.push(seq)
    }
  }
  return result
}

// ---------- 任务清单（通用存储里的 drone 行） ----------

export function listTasks(filters: Record<string, string> = {}): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  return listRows(DRONE_KEY).filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

function findTask(taskNo: string): EntryRow | undefined {
  return listRows(DRONE_KEY).find((row) => String(row['任务编号']) === taskNo)
}

function persistTasks(tasks: EntryRow[]): void {
  saveRows(DRONE_KEY, tasks)
}

// ---------- 飞手 ----------

export function listPilots(): DronePilot[] {
  return droneDomain().pilots
}

export function registerPilot(input: Omit<DronePilot, 'id' | '状态'>): ActionResult {
  if (!input.姓名.trim() || !input.工号.trim() || !input.资质编号.trim()) {
    return { ok: false, message: '姓名、工号、资质编号不能为空' }
  }
  const domain = droneDomain()
  if (domain.pilots.some((p) => p.姓名 === input.姓名.trim())) {
    return { ok: false, message: `飞手「${input.姓名}」已在册，不能重复登记` }
  }
  if (domain.pilots.some((p) => p.工号 === input.工号.trim())) {
    return { ok: false, message: `工号「${input.工号}」已被占用` }
  }
  const pilot: DronePilot = {
    id: nextId(domain.pilots),
    姓名: input.姓名.trim(),
    工号: input.工号.trim(),
    联系方式: input.联系方式.trim(),
    所属林场: input.所属林场.trim() || '未分配林场',
    资质编号: input.资质编号.trim(),
    状态: '在册',
  }
  saveDroneDomain((d) => void d.pilots.push(pilot))
  return { ok: true, message: `飞手「${pilot.姓名}」已登记入册` }
}

// ---------- 架次/航段 ----------

export function listSorties(taskNo = ''): DroneSortie[] {
  const rows = droneDomain().sorties
  return taskNo ? rows.filter((s) => s.任务编号 === taskNo) : rows
}

export function getSortie(sortieNo: string): DroneSortie | undefined {
  return droneDomain().sorties.find((s) => s.架次编号 === sortieNo)
}

function missingOf(sortie: DroneSortie): number[] {
  return missingSeqs(sortie.已接收段, sortie.总段数)
}

/**
 * 飞行区域补齐（区域为空时由系统决定，规则固定且可追溯）：
 * 1. 任务登记的飞行区域非空 → 沿用；
 * 2. 否则取航迹中第一个带区域的航段；
 * 3. 都没有 → 补标「未标注空域（任务编号 系统补标）」。
 */
export function resolveRegion(task: EntryRow, segments: StoredSegment[], taskNo: string): {
  region: string
  patched: boolean
} {
  const taskRegion = String(task['飞行区域'] ?? '').trim()
  if (taskRegion) {
    return { region: taskRegion, patched: false }
  }
  const fromTrack = segments.map((s) => s.飞行区域.trim()).find(Boolean)
  if (fromTrack) {
    return { region: fromTrack, patched: false }
  }
  return { region: `未标注空域（${taskNo} 系统补标）`, patched: true }
}

function fillEmptyRegion(segment: StoredSegment, region: string, source: string): StoredSegment {
  if (segment.飞行区域.trim()) {
    return segment
  }
  return { ...segment, 飞行区域: `${region}（${source}）`, 区域补齐: true }
}

// ---------- 核查提醒 ----------

export function listReminders(status = ''): CheckReminder[] {
  const rows = droneDomain().reminders
  const matched = status ? rows.filter((r) => r.状态 === status) : rows
  // 待核查排前面，同状态按发现时间倒序，空航迹不会产生提醒，也就不会重复占位。
  return [...matched].sort((a, b) => {
    if (a.状态 !== b.状态) {
      return a.状态 === '待核查' ? -1 : 1
    }
    return b.发现时间.localeCompare(a.发现时间)
  })
}

// 异常核查只能单向提交：待核查 → 已核查，没有任何动作能把它改回去。
export function checkReminder(id: number, conclusion: string, operator: string): ActionResult {
  const trimmed = conclusion.trim()
  if (!trimmed) {
    return { ok: false, message: '请填写核查结论后再提交' }
  }
  const domain = droneDomain()
  const reminder = domain.reminders.find((r) => r.id === id)
  if (!reminder) {
    return { ok: false, message: `没有找到编号为 ${id} 的核查提醒` }
  }
  if (reminder.状态 === '已核查') {
    return { ok: false, message: '该异常已核查，结论只能单向提交，不能重复核查' }
  }
  saveDroneDomain((d) => {
    const target = d.reminders.find((r) => r.id === id)
    if (!target) {
      return
    }
    target.状态 = '已核查'
    target.核查人 = operator
    target.核查时间 = now()
    target.核查结论 = trimmed
  })
  return { ok: true, message: `提醒 ${reminder.提醒编号} 的核查结论已提交` }
}

// ---------- 事务快照：任务、火情报告、提醒要么一起生效，要么一起回退 ----------

type Snapshot = {
  tasks: EntryRow[]
  reports: EntryRow[]
  sorties: DroneSortie[]
  reminders: CheckReminder[]
}

function takeSnapshot(): Snapshot {
  const domain = droneDomain()
  return {
    tasks: JSON.parse(JSON.stringify(listRows(DRONE_KEY))) as EntryRow[],
    reports: JSON.parse(JSON.stringify(listRows(REPORT_KEY))) as EntryRow[],
    sorties: JSON.parse(JSON.stringify(domain.sorties)) as DroneSortie[],
    reminders: JSON.parse(JSON.stringify(domain.reminders)) as CheckReminder[],
  }
}

function restoreSnapshot(snapshot: Snapshot): void {
  persistTasks(JSON.parse(JSON.stringify(snapshot.tasks)) as EntryRow[])
  saveRows(REPORT_KEY, JSON.parse(JSON.stringify(snapshot.reports)) as EntryRow[])
  saveDroneDomain((d) => {
    d.sorties = JSON.parse(JSON.stringify(snapshot.sorties)) as DroneSortie[]
    d.reminders = JSON.parse(JSON.stringify(snapshot.reminders)) as CheckReminder[]
  })
}

// 异常单向提交：报告与提醒只在首次满足条件时生成一次，重复上传不会再造一条。
function finalizeAnomalies(
  sortie: DroneSortie,
  task: EntryRow,
  region: string,
  ctx: { reports: EntryRow[]; reminders: CheckReminder[]; generatedReport: string; generatedReminder: string },
): void {
  if (sortie.异常数 <= 0 || sortie.已提交异常) {
    return
  }
  if (!sortie.完成声明 && String(task.status) !== '因故中止') {
    return
  }
  const reportNo = `FIRE-${sortie.任务编号}`
  if (!ctx.reports.some((r) => String(r['报告编号']) === reportNo)) {
    ctx.reports.push({
      id: nextId(ctx.reports),
      status: '待核实',
      pending: true,
      abnormal: true,
      报告编号: reportNo,
      起火地点: `无人机巡查发现：${region}`,
      起火时间: sortie.原始起飞时间 || now(),
      火势等级: '待现场判定',
      过火面积: '待核',
      扑救情况: '等待核查反馈',
      报告人: `无人机飞手 ${sortie.飞手姓名}`,
      报告状态: '待核实',
    })
    ctx.generatedReport = reportNo
  }
  const exists = ctx.reminders.some((r) => r.架次编号 === sortie.架次编号)
  if (!exists) {
    const reminder: CheckReminder = {
      id: nextId(ctx.reminders),
      提醒编号: `CHK-${String(nextId(ctx.reminders)).padStart(4, '0')}`,
      任务编号: sortie.任务编号,
      架次编号: sortie.架次编号,
      飞手姓名: sortie.飞手姓名,
      飞行区域: region,
      异常数: sortie.异常数,
      发现时间: now(),
      状态: '待核查',
      核查人: '',
      核查时间: '',
      核查结论: '',
    }
    ctx.reminders.push(reminder)
    sortie.关联报告编号 = reportNo
    sortie.关联提醒id = reminder.id
    ctx.generatedReminder = reminder.提醒编号
  }
  sortie.已提交异常 = true
}

type SideEffectContext = {
  reports: EntryRow[]
  reminders: CheckReminder[]
  generatedReport: string
  generatedReminder: string
}

// 事务体：改任务行、架次记账字段、报告与提醒；失败时整体回退（已落库航段不动）。
function applySideEffects(sortie: DroneSortie, ctx: SideEffectContext): void {
  const tasks = listRows(DRONE_KEY)
  const index = tasks.findIndex((row) => String(row['任务编号']) === sortie.任务编号)
  if (index < 0) {
    throw new Error('任务在提交过程中丢失，已回退本次提交')
  }
  const task = { ...tasks[index] }
  const segs = sortie.航段
  const { region } = resolveRegion(task, segs, sortie.任务编号)

  // 飞行区域：任务级区域为空时补齐，原始登记不为空则绝不覆盖。
  if (!String(task['飞行区域'] ?? '').trim()) {
    task['飞行区域'] = region
    task['区域补齐'] = true
  }
  task['飞手姓名'] = sortie.飞手姓名
  task['飞手id'] = sortie.飞手id
  if (!String(task['起飞时间'] ?? '').trim() && sortie.原始起飞时间) {
    task['起飞时间'] = sortie.原始起飞时间
  }

  const receivedAll = sortie.已接收段.length === sortie.总段数
  const current = String(task.status)
  let status = current
  if (current === '因故中止') {
    // 中止状态单向终态：航迹后传齐也不复活成飞行中/已完成。
    status = '因故中止'
    // 中止任务的航迹事务也是终态提交，重传不再生效。
    if (receivedAll) {
      sortie.完成声明 = true
      sortie.已收口 = true
    }
  } else if (sortie.完成声明 && receivedAll) {
    status = '已完成'
    if (!String(task['降落时间'] ?? '').trim() && sortie.原始降落时间) {
      task['降落时间'] = sortie.原始降落时间
    }
    if (!String(task['降落时间'] ?? '').trim()) {
      task['降落时间'] = now()
    }
    sortie.完成时间 = sortie.完成时间 || now()
    sortie.已收口 = true
  } else if (current === '待执行') {
    status = '飞行中'
  }
  task.status = status
  task['任务状态'] = status
  task['发现异常数'] = sortie.异常数
  task.abnormal = sortie.异常数 > 0
  task.pending = !CLOSED_STATUS.includes(status)

  finalizeAnomalies(sortie, task, region, ctx)

  tasks[index] = task
  persistTasks(tasks)
  if (ctx.reports !== listRows(REPORT_KEY)) {
    saveRows(REPORT_KEY, ctx.reports)
  }
  saveDroneDomain((d) => {
    const idx = d.sorties.findIndex((s) => s.id === sortie.id)
    if (idx >= 0) {
      d.sorties[idx] = sortie
    }
  })
}

// ---------- 航迹上传 ----------

function validateSegmentInput(input: UploadTrackInput, total: number): string {
  if (!Array.isArray(input.航段) || input.航段.length === 0) {
    return '空航迹不能提交：未接收到任何航段，任务、报告与提醒均不会生成'
  }
  const seqs = new Set<number>()
  for (const seg of input.航段) {
    if (!isInt(seg.seq) || seg.seq < 1 || seg.seq > total) {
      return `航段序号必须是 1-${total} 之间的整数，收到「${String(seg.seq)}」`
    }
    if (seqs.has(seg.seq)) {
      return `同一批次内航段 ${seg.seq} 重复出现，请去重后再传`
    }
    seqs.add(seg.seq)
    if (!isInt(seg.异常数) || seg.异常数 < 0) {
      return `航段 ${seg.seq} 的异常数必须是非负整数`
    }
    if (!String(seg.起飞时间 ?? '').trim()) {
      return `航段 ${seg.seq} 缺少起飞时间，原始起降时间需随航迹保留`
    }
  }
  return ''
}

export function isUploading(): boolean {
  return uploadInFlight
}

export async function uploadTrack(input: UploadTrackInput): Promise<UploadTrackResult> {
  // 并发上传：第二次提交直接拒绝（含状态流转按钮的互斥判断）。
  if (uploadInFlight) {
    return fail('已有航迹正在提交，并发提交已被拒绝，请完成后再试', input.架次编号)
  }
  const task = findTask(input.任务编号)
  if (!task) {
    return fail(`没有找到任务 ${input.任务编号}`, input.架次编号)
  }
  const pilot = droneDomain().pilots.find(
    (p) => p.姓名 === input.飞手姓名.trim() && p.状态 === '在册',
  )
  if (!pilot) {
    return fail(`飞手「${input.飞手姓名}」不在册或已停飞，航迹需挂在册飞手`, input.架次编号)
  }
  if (!isInt(input.总段数) || input.总段数 < 1) {
    return fail('计划航段总数必须是正整数', input.架次编号)
  }
  const segmentError = validateSegmentInput(input, input.总段数)
  if (segmentError) {
    return fail(segmentError, input.架次编号)
  }

  uploadInFlight = true
  try {
    // 模拟网络在途：此时第二个并发请求会命中顶部的提交锁。
    await new Promise((resolve) => setTimeout(resolve, UPLOAD_LATENCY_MS))

    const domain = droneDomain()
    let sortie = domain.sorties.find((s) => s.架次编号 === input.架次编号)
    if (sortie && sortie.任务编号 !== input.任务编号) {
      return fail(`架次 ${input.架次编号} 属于任务 ${sortie.任务编号}，不能挂到别的任务下`, input.架次编号, sortie.已接收段)
    }
    if (sortie && sortie.已收口) {
      // 同一架次只生效一次：已收口（事务完整提交）的架次重复上传整体拒绝。
      return fail(`架次 ${input.架次编号} 已完整生效，重复上传只保留首次结果`, input.架次编号, sortie.已接收段)
    }
    if (!sortie && CLOSED_STATUS.includes(String(task.status))) {
      return fail(`任务已${String(task.status)}，不能再为它新开架次`, input.架次编号)
    }

    // ---- 阶段 A：航段落库（持久保留，失败回退不清——续传就靠它） ----
    let created = false
    if (!sortie) {
      created = true
      sortie = {
        id: nextId(domain.sorties),
        架次编号: input.架次编号,
        任务编号: input.任务编号,
        飞手id: pilot.id,
        飞手姓名: pilot.姓名,
        总段数: input.总段数,
        已接收段: [],
        航段: [],
        原始起飞时间: '',
        原始降落时间: '',
        异常数: 0,
        已提交异常: false,
        关联报告编号: '',
        关联提醒id: 0,
        完成声明: false,
        已收口: false,
        完成时间: '',
        创建时间: now(),
        最近上传时间: now(),
        最近批次: 0,
        上传日志: [],
      }
    } else {
      sortie = JSON.parse(JSON.stringify(sortie)) as DroneSortie
    }

    const accepted: number[] = []
    const duplicated: number[] = []
    for (const incoming of [...input.航段].sort((a, b) => a.seq - b.seq)) {
      if (sortie.已接收段.includes(incoming.seq)) {
        // 航段幂等：重传同一航段不重复计数、不重复入库。
        duplicated.push(incoming.seq)
        continue
      }
      sortie.航段.push({ ...incoming, 区域补齐: false })
      sortie.已接收段.push(incoming.seq)
      accepted.push(incoming.seq)
    }
    sortie.已接收段.sort((a, b) => a - b)
    sortie.航段.sort((a, b) => a.seq - b.seq)

    // 区域补齐：空区域航段按 任务区域 → 上段区域 → 系统补标 的顺序补齐。
    const { region: resolvedRegion, patched } = resolveRegion(task, sortie.航段, sortie.任务编号)
    sortie.航段 = sortie.航段.map((s) => {
      if (s.区域补齐) {
        return s
      }
      const source = String(task['飞行区域'] ?? '').trim() ? '沿用任务区域补齐' : patched ? '系统补标' : '沿用上段区域补齐'
      return fillEmptyRegion(s, resolvedRegion, source)
    })

    // 原始起降时间：首次写入后保留，任何重传都不覆盖。
    const starts = input.航段.map((s) => s.起飞时间).filter(Boolean).sort()
    const ends = input.航段.map((s) => s.降落时间).filter(Boolean).sort()
    if (!sortie.原始起飞时间 && starts.length) {
      sortie.原始起飞时间 = starts[0]
    }
    if (!sortie.原始降落时间 && ends.length) {
      sortie.原始降落时间 = ends[ends.length - 1]
    }

    sortie.异常数 = sortie.航段.reduce((sum, s) => sum + s.异常数, 0)
    // 完成声明只在事务成功后落盘：失败回退时架次保持「未收口」，允许重传补做提交。
    sortie.完成声明 = false
    sortie.最近批次 += 1
    sortie.最近上传时间 = now()

    // 航段先落盘（A 阶段结果不受事务回退影响）。
    saveDroneDomain((d) => {
      const idx = d.sorties.findIndex((s) => s.id === sortie!.id)
      if (idx >= 0) {
        d.sorties[idx] = sortie!
      } else {
        d.sorties.push(sortie!)
      }
    })

    const receivedAfter = [...sortie.已接收段]
    const missingAfter = missingSeqs(receivedAfter, sortie.总段数)
    const dupNote = duplicated.length ? `；航段 ${duplicated.join('、')} 此前已接收，未重复生效` : ''

    // ---- 阶段 B：任务/报告/提醒事务提交 ----
    const snapshot = takeSnapshot()
    const ctx: SideEffectContext = {
      reports: JSON.parse(JSON.stringify(listRows(REPORT_KEY))) as EntryRow[],
      reminders: droneDomain().reminders,
      generatedReport: '',
      generatedReminder: '',
    }
    let failedMessage = ''
    try {
      const txSortie = JSON.parse(JSON.stringify(sortie)) as DroneSortie
      txSortie.完成声明 = Boolean(input.完成声明)
      applySideEffects(txSortie, ctx)
      if (input.强制失败) {
        throw new Error('模拟提交失败（用于验证回退与缺失航段续传）')
      }
    } catch (error) {
      failedMessage = error instanceof Error ? error.message : '提交失败'
    }

    // 重新读回事务后的架次（applySideEffects 内部更新了记账字段）。
    const liveSortie = getSortie(sortie.架次编号) ?? sortie

    if (failedMessage) {
      restoreSnapshot(snapshot)
      // 回退后补记失败日志（航段保留），返回列表再进来可据此从缺失航段续传。
      saveDroneDomain((d) => {
        const target = d.sorties.find((s) => s.架次编号 === input.架次编号)
        if (target) {
          target.上传日志.push({
            时间: now(),
            批次: target.最近批次,
            接收段: accepted,
            结果: `提交失败已回退：${failedMessage}；缺失航段：${missingAfter.join('、') || '无'}`,
          })
        }
      })
      return {
        ok: false,
        message: `${failedMessage}。任务、火情报告、核查提醒已一起回退；已接收航段 ${receivedAfter.join('、') || '无'} 保留${dupNote}，请从缺失航段 ${missingAfter.join('、') || '（无）'} 续传`,
        架次编号: input.架次编号,
        本批接收: accepted,
        已接收段: receivedAfter,
        缺失段: missingAfter,
        异常数: sortie.异常数,
        任务状态: String(task.status),
        生成报告: '',
        生成提醒: '',
      }
    }

    const complete = sortie.完成声明 && missingAfter.length === 0 && String(task.status) !== '因故中止'
    saveDroneDomain((d) => {
      const target = d.sorties.find((s) => s.架次编号 === input.架次编号)
      if (target) {
        target.上传日志.push({
          时间: now(),
          批次: target.最近批次,
          接收段: accepted,
          结果: complete
            ? `航迹齐全，异常单向提交 ${target.异常数} 处`
            : `部分接收，缺失航段：${missingAfter.join('、') || '无'}`,
        })
      }
    })

    const refreshedTask = findTask(input.任务编号)
    const noteParts = [
      created ? '已新建架次' : '架次续传',
      accepted.length ? `本批接收航段 ${accepted.join('、')}` : '本批无新增航段',
    ]
    if (dupNote) {
      noteParts.push(dupNote.replace('；', ''))
    }
    if (missingAfter.length) {
      noteParts.push(`仍缺失航段 ${missingAfter.join('、')}`)
    }
    if (complete) {
      noteParts.push('任务已完成')
    }
    if (refreshedTask && String(refreshedTask.status) === '因故中止') {
      noteParts.push('任务为因故中止终态，状态不回退')
    }
    return {
      ok: true,
      message: noteParts.join('；'),
      架次编号: input.架次编号,
      本批接收: accepted,
      已接收段: receivedAfter,
      缺失段: missingAfter,
      异常数: liveSortie.异常数,
      任务状态: refreshedTask ? String(refreshedTask.status) : '',
      生成报告: ctx.generatedReport,
      生成提醒: ctx.generatedReminder,
    }
  } finally {
    uploadInFlight = false
  }
}

// ---------- 任务状态流转（单向受控） ----------

export function transitionTask(id: number, action: string): ActionResult {
  if (uploadInFlight) {
    return { ok: false, message: '航迹正在提交中，请等待本次上传结束后再操作任务' }
  }
  const tasks = listRows(DRONE_KEY)
  const index = tasks.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的无人机巡查任务` }
  }
  const task = { ...tasks[index] }
  const taskNo = String(task['任务编号'])
  const current = String(task.status)

  if (action === '开始飞行') {
    if (current !== '待执行') {
      return { ok: false, message: `任务当前为「${current}」，只有待执行任务可以开始飞行` }
    }
    task.status = '飞行中'
    task['任务状态'] = '飞行中'
    task.pending = true
    if (!String(task['起飞时间'] ?? '').trim()) {
      task['起飞时间'] = now()
    }
    tasks[index] = task
    persistTasks(tasks)
    return { ok: true, message: `任务 ${taskNo} 已开始飞行` }
  }

  if (action === '确认完成') {
    if (current !== '飞行中') {
      return { ok: false, message: `任务当前为「${current}」，只有飞行中的任务可以确认完成` }
    }
    const partial = droneDomain().sorties.find(
      (s) => s.任务编号 === taskNo && s.已接收段.length < s.总段数,
    )
    if (partial) {
      return {
        ok: false,
        message: `架次 ${partial.架次编号} 还缺航段 ${missingOf(partial).join('、')}，请先从缺失航段续传再完成`,
      }
    }
    task.status = '已完成'
    task['任务状态'] = '已完成'
    task.pending = false
    if (!String(task['降落时间'] ?? '').trim()) {
      task['降落时间'] = now()
    }
    tasks[index] = task
    persistTasks(tasks)
    return { ok: true, message: `任务 ${taskNo} 已完成` }
  }

  if (action === '中止任务') {
    if (!['待执行', '飞行中'].includes(current)) {
      // 终态单向：已完成/已中止不能再点中止，修掉「中止后仍显示飞行中」类的状态反复。
      return { ok: false, message: `任务当前为「${current}」，已是终态，不能中止` }
    }
    const snapshot = takeSnapshot()
    try {
      task.status = '因故中止'
      task['任务状态'] = '因故中止'
      task.pending = false
      task.abnormal = Number(task['发现异常数'] || 0) > 0
      tasks[index] = task
      persistTasks(tasks)

      // 中止时已有航迹异常：异常数回写并单向提交报告+提醒；随事务一起生效。
      const ctx: SideEffectContext = {
        reports: JSON.parse(JSON.stringify(listRows(REPORT_KEY))) as EntryRow[],
        reminders: droneDomain().reminders,
        generatedReport: '',
        generatedReminder: '',
      }
      saveDroneDomain((d) => {
        for (const sortie of d.sorties.filter((s) => s.任务编号 === taskNo)) {
          const region = String(task['飞行区域'] ?? '').trim() || '未标注空域（系统补标）'
          finalizeAnomalies(sortie, task, region, ctx)
        }
      })
      saveRows(REPORT_KEY, ctx.reports)
      return {
        ok: true,
        message: `任务 ${taskNo} 已因故中止${ctx.generatedReport ? `，异常已提交（${ctx.generatedReport}）` : ''}`,
      }
    } catch (error) {
      restoreSnapshot(snapshot)
      return { ok: false, message: error instanceof Error ? error.message : '中止失败，已回退' }
    }
  }

  return { ok: false, message: `无人机任务没有登记「${action}」这个动作` }
}

// ---------- 统计与重置 ----------

export function droneStats(): DroneStats {
  const tasks = listRows(DRONE_KEY)
  const today = todayStr()
  return {
    今日飞行任务: tasks.filter((t) => String(t['起飞时间'] ?? '').startsWith(today)).length,
    已完成任务: tasks.filter((t) => String(t.status) === '已完成').length,
    发现异常数: tasks.reduce((sum, t) => sum + (Number(t['发现异常数']) || 0), 0),
  }
}

export function statusSummary(): { status: string; count: number }[] {
  const tasks = listRows(DRONE_KEY)
  return TASK_STATUSES.map((status) => ({
    status,
    count: tasks.filter((t) => String(t.status) === status).length,
  }))
}

export function resetDrone(): ActionResult {
  if (uploadInFlight) {
    return { ok: false, message: '航迹正在提交中，不能重置示例数据' }
  }
  // 通用清单先回种子（drone + firereport），再由域种子重新追加联动报告。
  persistTasks(JSON.parse(JSON.stringify(seedRowsOf(DRONE_KEY))) as EntryRow[])
  saveRows(REPORT_KEY, JSON.parse(JSON.stringify(seedRowsOf(REPORT_KEY))) as EntryRow[])
  resetDroneDomain()
  return { ok: true, message: '无人机巡查示例数据已重置' }
}
