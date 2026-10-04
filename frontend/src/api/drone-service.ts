import { commitDB, droneDB } from '@/data/drone/drone-store'
import type {
  AnomalyItem,
  DroneDB,
  DroneTask,
  Reminder,
  Sortie,
  TaskStatus,
} from '@/data/drone/types'
import type { EntryRow } from '@/data/types'

export { droneDB }

// —— 常量与结果类型 ——

export type ServiceResult = { ok: boolean; message: string }

/** 飞行区域逐级兜底：任务区域 → 飞手责任区 → 未登记飞行区域（由服务端补齐并写进架次）。 */
export const FALLBACK_AREA = '未登记飞行区域'

// 进行中的上传只允许同一架次一份：内存锁挡住同一标签页的并发提交（含双击）。
const uploadingSorties = new Set<string>()

export type UploadProgress = {
  sortieId: string
  /** 刚传成功的航段序号 */
  segmentIndex: number
  total: number
}

export type UploadInput = {
  taskId: number
  /** 架次号：同一任务内由页面给出（续传时为已存在架次的架次号）。 */
  sortieNo: number
  /** 飞手端填报的飞行区域，空串/缺省触发补齐。 */
  area?: string
  takeoffAt: string
  landingAt: string
  /** 本次提交的航段定义（续传时按序号与已传航段对齐）。 */
  segments: { name: string; point: string }[]
  /** 飞手端随架次上报的原始异常，仅在首次上传时落库。 */
  anomalies?: AnomalyItem[]
  /** 标记“在该航段上传失败”，序号数组；用于演示失败/续传。 */
  failSegmentIndexes?: number[]
  /** 每个航段的模拟耗时，默认 30ms。 */
  delayMs?: number
  onProgress?: (progress: UploadProgress) => void
}

export type UploadOutcome = ServiceResult & {
  sortieId: string | null
  /** 失败后第一个缺失（未传成功）的航段序号，页面据此提示续传起点。 */
  missingSegment: number | null
  duplicated?: boolean
}

// —— 通用工具 ——

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

export function nowText(): string {
  const d = new Date()
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  )
}

function sortieId(taskId: number, sortieNo: number): string {
  return `${taskId}-${sortieNo}`
}

function reportId(sortieKey: string, anomalyNo: number): string {
  return `R-${sortieKey}-${anomalyNo}`
}

function reminderId(sortieKey: string, anomalyNo: number): string {
  return `REM-${sortieKey}-${anomalyNo}`
}

export function resolvePilot(db: DroneDB, pilotId: number) {
  return db.pilots.find((p) => p.id === pilotId) ?? null
}

/** 解析一次架次实际使用的飞行区域：任务区域 → 飞手责任区 → 兜底文案。 */
export function resolveArea(task: DroneTask, pilotArea: string | undefined, inputArea?: string): string {
  const declared = (inputArea ?? '').trim()
  if (declared) {
    return declared
  }
  if (task.area.trim()) {
    return task.area.trim()
  }
  if (pilotArea && pilotArea.trim()) {
    return pilotArea.trim()
  }
  return FALLBACK_AREA
}

// —— 查询：任务 / 航迹 / 提醒 ——

export type TaskView = DroneTask & {
  pilotName: string
  /** 列表展示用的区域：任务区域为空时提示“未登记（上传时补齐）”，不伪造数据。 */
  areaLabel: string
}

export function toTaskView(db: DroneDB, task: DroneTask): TaskView {
  const pilot = resolvePilot(db, task.pilotId)
  return {
    ...task,
    pilotName: pilot ? pilot.name : `飞手#${task.pilotId}`,
    areaLabel: task.area.trim() ? task.area : `未登记（上传时按飞手责任区补齐）`,
  }
}

export function listTasks(filters: Record<string, string> = {}): TaskView[] {
  const db = droneDB()
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  return db.tasks
    .map((task) => toTaskView(db, task))
    .filter((task) =>
      pairs.every(([field, value]) => {
        const source =
          field === '飞手姓名'
            ? task.pilotName
            : field === '飞行区域'
              ? `${task.area} ${task.areaLabel}`
              : String(task[field as keyof TaskView] ?? '')
        return source.includes(value.trim())
      }),
    )
}

export type TrackDetail = {
  task: TaskView
  sortie: Sortie
  segments: Sortie['segments']
  anomalies: AnomalyItem[]
  reports: { reportId: string; anomalyNo: number; description: string; location: string; reportedAt: string }[]
  uploaded: boolean
}

export function listSortiesOfTask(taskId: number): Sortie[] {
  return droneDB()
    .sorties.filter((s) => s.taskId === taskId)
    .sort((a, b) => a.sortieNo - b.sortieNo)
}

/** 航迹详情按 sortieId 取，找不到给 null，由页面给空态，绝不合成空航迹。 */
export function getTrackDetail(sortieKey: string): TrackDetail | null {
  const db = droneDB()
  const sortie = db.sorties.find((s) => s.id === sortieKey)
  if (!sortie) {
    return null
  }
  const task = db.tasks.find((t) => t.id === sortie.taskId)
  if (!task) {
    return null
  }
  const reports = db.reports
    .filter((r) => r.sortieId === sortieKey)
    .sort((a, b) => a.anomalyNo - b.anomalyNo)
    .map((r) => ({
      reportId: r.id,
      anomalyNo: r.anomalyNo,
      description: r.description,
      location: r.location,
      reportedAt: r.reportedAt,
    }))
  return {
    task: toTaskView(db, task),
    sortie,
    segments: sortie.segments,
    anomalies: sortie.anomalies,
    reports,
    uploaded: sortie.status === '已上传',
  }
}

export function nextSortieNo(taskId: number): number {
  const list = listSortiesOfTask(taskId)
  return list.length === 0 ? 1 : list[list.length - 1].sortieNo + 1
}

export type ReminderView = Reminder & {
  taskCode: string
  areaLabel: string
  pilotName: string
  taskStatus: TaskStatus
}

export function listReminders(includeResolved = false): ReminderView[] {
  const db = droneDB()
  return db.reminders
    .filter((r) => includeResolved || !r.resolved)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((r) => {
      const task = db.tasks.find((t) => t.id === r.taskId)
      return {
        ...r,
        taskCode: task ? task.code : `任务#${r.taskId}`,
        areaLabel: task ? toTaskView(db, task).areaLabel : '',
        pilotName: task ? (resolvePilot(db, task.pilotId)?.name ?? '') : '',
        taskStatus: task ? task.status : '待执行',
      }
    })
}

// —— 任务状态流转：三处展示共用状态机，中止后一律是「因故中止」，不会再被当成飞行中 ——

function findTask(db: DroneDB, taskId: number): DroneTask | null {
  return db.tasks.find((t) => t.id === taskId) ?? null
}

function hasCompletedSortie(db: DroneDB, taskId: number): boolean {
  return db.sorties.some((s) => s.taskId === taskId && s.status === '已上传')
}

function taskInFlight(sortie: Sortie | undefined): boolean {
  return sortie?.status === '上传中'
}

export function startTask(taskId: number): ServiceResult {
  const db = clone(droneDB())
  const task = findTask(db, taskId)
  if (!task) {
    return { ok: false, message: '没有找到该无人机巡查任务' }
  }
  if (task.status !== '待执行') {
    return { ok: false, message: `任务当前为「${task.status}」，只有待执行任务可以开始飞行` }
  }
  task.status = '飞行中'
  // 原始起飞时间缺失才补，已经存在的一律保留。
  if (!task.takeoffAt.trim()) {
    task.takeoffAt = nowText()
  }
  commitDB(db)
  return { ok: true, message: `任务 ${task.code} 已开始飞行` }
}

export function completeTask(taskId: number): ServiceResult {
  const db = clone(droneDB())
  const task = findTask(db, taskId)
  if (!task) {
    return { ok: false, message: '没有找到该无人机巡查任务' }
  }
  if (db.sorties.some((s) => s.taskId === taskId && s.status === '上传中')) {
    return { ok: false, message: '仍有架次正在上传，请等上传结束后再确认完成' }
  }
  if (task.status !== '飞行中') {
    return { ok: false, message: `任务当前为「${task.status}」，只有飞行中的任务可以确认完成` }
  }
  if (!hasCompletedSortie(db, taskId)) {
    return { ok: false, message: '还没有完整上传成功的架次航迹，不能确认完成' }
  }
  task.status = '已完成'
  if (!task.landingAt.trim()) {
    task.landingAt = nowText()
  }
  commitDB(db)
  return { ok: true, message: `任务 ${task.code} 已完成` }
}

export function abortTask(taskId: number): ServiceResult {
  const db = clone(droneDB())
  const task = findTask(db, taskId)
  if (!task) {
    return { ok: false, message: '没有找到该无人机巡查任务' }
  }
  if (task.status === '已完成' || task.status === '因故中止') {
    return { ok: false, message: `任务已经是「${task.status}」，不能中止` }
  }
  if (db.sorties.some((s) => s.taskId === taskId && s.status === '上传中')) {
    return { ok: false, message: '架次正在上传，暂不能中止任务' }
  }
  task.status = '因故中止'
  if (!task.landingAt.trim()) {
    task.landingAt = nowText()
  }
  commitDB(db)
  return { ok: true, message: `任务 ${task.code} 已中止` }
}

export function resolveReminder(reminderKey: string): ServiceResult {
  const db = clone(droneDB())
  const reminder = db.reminders.find((r) => r.id === reminderKey)
  if (!reminder) {
    return { ok: false, message: '没有找到该核查提醒' }
  }
  if (reminder.resolved) {
    return { ok: false, message: '该核查提醒已经处理过' }
  }
  reminder.resolved = true
  reminder.resolvedAt = nowText()
  commitDB(db)
  return { ok: true, message: '核查提醒已标记为已处理' }
}

// —— 异常单向提交：只生成、不撤回；同一架次同一异常只提交一次 ——

function submitAnomaliesOnce(db: DroneDB, sortie: Sortie, task: DroneTask, pilotName: string): void {
  for (const anomaly of sortie.anomalies) {
    const rid = reportId(sortie.id, anomaly.no)
    // 已提交过的异常不重复生成报告与待办，保证“同一架次只生效一次”。
    if (db.reports.some((r) => r.id === rid)) {
      continue
    }
    db.reports.push({
      id: rid,
      sortieId: sortie.id,
      taskId: task.id,
      anomalyNo: anomaly.no,
      description: anomaly.description,
      location: anomaly.location,
      area: sortie.area,
      pilotName,
      reportedAt: nowText(),
      submitted: true,
    })
    const remId = reminderId(sortie.id, anomaly.no)
    if (!db.reminders.some((r) => r.id === remId)) {
      db.reminders.push({
        id: remId,
        taskId: task.id,
        sortieId: sortie.id,
        reportId: rid,
        title: `核查${anomaly.description}`,
        detail: `${anomaly.location}（${pilotName} · ${task.code}）`,
        createdAt: nowText(),
        resolved: false,
        resolvedAt: null,
      })
    }
  }
}

/**
 * 提交某架次的异常报告（幂等入口）。
 * 异常只能单向提交：已提交的再调直接拒绝，且系统不提供任何撤回接口。
 */
export function submitAnomalyReports(sortieKey: string): ServiceResult {
  const db = clone(droneDB())
  const sortie = db.sorties.find((s) => s.id === sortieKey)
  if (!sortie) {
    return { ok: false, message: '没有找到该架次' }
  }
  if (sortie.status !== '已上传') {
    return { ok: false, message: '架次尚未上传成功，异常报告要等航迹上传完成后才能提交' }
  }
  if (sortie.anomalies.length === 0) {
    return { ok: false, message: '该架次没有需要提交的异常' }
  }
  const pending = sortie.anomalies.filter(
    (a) => !db.reports.some((r) => r.id === reportId(sortie.id, a.no)),
  )
  if (pending.length === 0) {
    return { ok: false, message: '该架次的异常已经提交过，不能重复提交' }
  }
  const task = findTask(db, sortie.taskId)
  if (!task) {
    return { ok: false, message: '没有找到该架次所属任务' }
  }
  submitAnomaliesOnce(db, sortie, task, sortie.pilotName)
  commitDB(db)
  return { ok: true, message: `已提交 ${pending.length} 条异常报告，并生成核查提醒` }
}

// —— 架次上传：幂等、断点续传、并发拒绝、失败整体回退（任务/报告/提醒） ——

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function uploadSortie(input: UploadInput): Promise<UploadOutcome> {
  const key = sortieId(input.taskId, input.sortieNo)

  // 并发上传同一架次：第二次提交直接拒绝（异步锁，连 await 让出期间的并发也挡得住）。
  if (uploadingSorties.has(key)) {
    return { ok: false, message: '同一架次正在上传，请勿重复提交', sortieId: key, missingSegment: null }
  }

  // 幂等：整架次已上传成功，重复上传只生效一次。
  const existing = droneDB().sorties.find((s) => s.id === key)
  if (existing && existing.status === '已上传') {
    return {
      ok: true,
      message: `架次 ${input.sortieNo} 已上传成功，重复提交不重复生效`,
      sortieId: key,
      missingSegment: null,
      duplicated: true,
    }
  }

  // 入参校验（不碰锁、不写库）。
  const task = droneDB().tasks.find((t) => t.id === input.taskId)
  if (!task) {
    return { ok: false, message: '没有找到该无人机巡查任务', sortieId: key, missingSegment: null }
  }
  const pilot = resolvePilot(droneDB(), task.pilotId)
  const pilotName = pilot ? pilot.name : `飞手#${task.pilotId}`
  if (!input.takeoffAt.trim() || !input.landingAt.trim()) {
    return { ok: false, message: '原始起降时间缺失，不能上传', sortieId: key, missingSegment: null }
  }
  if (input.segments.length === 0 || input.segments.every((seg) => !seg.name.trim())) {
    // 空航迹直接拒收：不生成架次、不生成待办，更不会重复出现。
    return { ok: false, message: '航迹为空，没有可上传的航段，已拒绝该架次', sortieId: null, missingSegment: null }
  }

  uploadingSorties.add(key)
  try {
    // 进入尝试：准备工作副本与架次（新建或续传），并把任务状态先拨到「飞行中」。
    const db = clone(droneDB())
    const workTask = findTask(db, input.taskId)!
    const statusBefore = workTask.status
    let sortie = db.sorties.find((s) => s.id === key)
    const area = resolveArea(workTask, pilot?.defaultArea, input.area)

    if (!sortie) {
      sortie = {
        id: key,
        taskId: input.taskId,
        sortieNo: input.sortieNo,
        area,
        route: workTask.route,
        pilotName,
        // 原始起降时间在首次上传时落库，之后任何重试都保留它。
        takeoffAt: input.takeoffAt,
        landingAt: input.landingAt,
        segments: input.segments.map((seg, index) => ({
          index,
          name: seg.name.trim(),
          point: seg.point.trim(),
          uploaded: false,
        })),
        anomalies: clone(input.anomalies ?? []),
        status: '上传中',
        uploadedAt: null,
        failAtSegment: null,
      }
      db.sorties.push(sortie)
    } else {
      // 续传：补齐可能新增的航段定义，已传成功的航段原样保留。
      sortie.segments = input.segments.map((seg, index) => {
        const old = sortie!.segments.find((item) => item.index === index)
        return old
          ? old
          : { index, name: seg.name.trim(), point: seg.point.trim(), uploaded: false }
      })
      sortie.area = sortie.area || area
      // 起降时间保留首次的原始值，不被本次提交覆盖。
      sortie.takeoffAt = sortie.takeoffAt || input.takeoffAt
      sortie.landingAt = sortie.landingAt || input.landingAt
      sortie.status = '上传中'
      sortie.failAtSegment = null
    }

    workTask.status = '飞行中'
    commitDB(db)

    // 逐航段上传：从第一个缺失航段开始，模拟网络/链路延迟与失败。
    const failSet = new Set(input.failSegmentIndexes ?? [])
    const stepMs = input.delayMs ?? 30
    for (const segment of sortie.segments) {
      if (segment.uploaded) {
        continue
      }
      await delay(stepMs)
      if (failSet.has(segment.index)) {
        // —— 失败补偿：已传航段保留（支持从缺失航段重试）——
        const failDB = clone(droneDB())
        const failSortie = failDB.sorties.find((s) => s.id === key)!
        failSortie.status = '上传失败'
        failSortie.failAtSegment = segment.index
        // 任务状态回退到本次尝试之前：本次尝试拨成的「飞行中」撤销，中止的任务仍显示「因故中止」。
        const failTask = findTask(failDB, input.taskId)!
        failTask.status = statusBefore
        // 失败前不落任何报告/提醒（它们只在成功阶段产生），任务、报告、提醒一起回退。
        commitDB(failDB)
        return {
          ok: false,
          message: `航段 ${segment.index + 1}（${segment.name || '未命名航段'}）上传失败，已回退，可从该航段续传`,
          sortieId: key,
          missingSegment: segment.index,
        }
      }
      segment.uploaded = true
      // 每传成功一段就落库：失败后这些航段仍在，作为断点续传的进度。
      const progressDB = clone(droneDB())
      const progressSortie = progressDB.sorties.find((s) => s.id === key)!
      const target = progressSortie.segments.find((item) => item.index === segment.index)
      if (target) {
        target.uploaded = true
      }
      commitDB(progressDB)
      input.onProgress?.({ sortieId: key, segmentIndex: segment.index, total: sortie.segments.length })
    }

    // —— 全部航段成功：成功阶段作为一笔事务，任务/报告/提醒要么全成、要么全退 ——
    const finalDB = clone(droneDB())
    try {
      const finalSortie = finalDB.sorties.find((s) => s.id === key)!
      const finalTask = findTask(finalDB, input.taskId)!
      finalSortie.status = '已上传'
      finalSortie.uploadedAt = nowText()
      finalSortie.failAtSegment = null
      // 异常数回写任务：列表、航迹详情、概览读到的是同一个数字。
      // 异常报告不在这里自动产生——异常只能由「提交异常报告」单向提交。
      finalTask.anomalyCount = finalDB.sorties
        .filter((s) => s.taskId === finalTask.id && s.status === '已上传')
        .reduce((sum, s) => sum + s.anomalies.length, 0)
      commitDB(finalDB)
    } catch (error) {
      // 成功阶段任何一步失败：整体回退到本次尝试前（已传航段仍保留，允许再次续传）。
      const rollbackDB = clone(droneDB())
      const rollbackSortie = rollbackDB.sorties.find((s) => s.id === key)!
      rollbackSortie.status = '上传失败'
      const rbTask = findTask(rollbackDB, input.taskId)!
      rbTask.status = statusBefore
      commitDB(rollbackDB)
      return {
        ok: false,
        message: error instanceof Error ? `上传收尾失败，已整体回退：${error.message}` : '上传收尾失败，已整体回退',
        sortieId: key,
        missingSegment: rollbackSortie.segments.find((s) => !s.uploaded)?.index ?? null,
      }
    }

    return {
      ok: true,
      message:
        `架次 ${input.sortieNo} 上传成功，共 ${sortie.segments.length} 个航段` +
        (sortie.anomalies.length
          ? `，上报异常 ${sortie.anomalies.length} 条，请在航迹详情提交异常报告`
          : ''),
      sortieId: key,
      missingSegment: null,
    }
  } finally {
    uploadingSorties.delete(key)
  }
}

// —— 通用列表/概览适配：让无人机任务接入既有表格与运营概览 ——

/** 把无人机任务映射成通用 EntryRow；pending/abnormal 由同一状态机派生，不允许页面各算各的。 */
export function droneTaskRows(): EntryRow[] {
  const db = droneDB()
  return db.tasks.map((task) => {
    const view = toTaskView(db, task)
    return {
      id: task.id,
      status: task.status,
      // 待执行/飞行中算待处理；已中止、已完成不算待办。
      pending: task.status === '待执行' || task.status === '飞行中',
      abnormal: task.anomalyCount > 0,
      任务编号: task.code,
      飞行区域: view.areaLabel,
      飞行路线: task.route,
      飞手姓名: view.pilotName,
      起飞时间: task.takeoffAt || '—',
      降落时间: task.landingAt || '—',
      发现异常数: task.anomalyCount,
      任务状态: task.status,
    }
  })
}

export type DroneStats = {
  todaySorties: number
  completedTasks: number
  anomalyCount: number
  pendingReminders: number
}

export function droneStats(): DroneStats {
  const db = droneDB()
  const today = nowText().slice(0, 10)
  return {
    todaySorties: db.sorties.filter(
      (s) => s.status === '已上传' && (s.uploadedAt ?? '').startsWith(today),
    ).length,
    completedTasks: db.tasks.filter((t) => t.status === '已完成').length,
    anomalyCount: db.tasks.reduce((sum, t) => sum + t.anomalyCount, 0),
    pendingReminders: db.reminders.filter((r) => !r.resolved).length,
  }
}
