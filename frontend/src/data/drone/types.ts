/** 无人机巡查领域模型：飞手 → 任务 → 架次/航迹 → 异常报告 → 核查提醒。 */

/** 任务状态：四个值在任务列表、航迹详情、核查提醒三处共用同一份数据，不允许页面各自维护。 */
export type TaskStatus = '待执行' | '飞行中' | '已完成' | '因故中止'

/** 架次上传状态：未上传 / 上传中 / 已上传 / 上传失败（失败后保留已传航段，供断点续传）。 */
export type SortieStatus = '未上传' | '上传中' | '已上传' | '上传失败'

export interface Pilot {
  id: number
  /** 飞手姓名：任务经飞手串联，上传时从飞手责任区补齐飞行区域。 */
  name: string
  /** 默认责任林区：任务没填飞行区域时的兜底来源。 */
  defaultArea: string
}

export interface DroneTask {
  id: number
  /** 任务编号 */
  code: string
  /** 飞行区域，允许为空（上传时按 任务区域 → 飞手责任区 → 未登记飞行区域 补齐）。 */
  area: string
  /** 飞行路线 */
  route: string
  pilotId: number
  status: TaskStatus
  /** 原始起飞时间，一旦实际写入就只能保留、不能被重传覆盖。 */
  takeoffAt: string
  /** 原始降落时间，规则同起飞时间。 */
  landingAt: string
  /** 发现异常数：架次上传成功后回写，列表/概览都读这里。 */
  anomalyCount: number
}

export interface TrackSegment {
  /** 航段序号，从 0 开始。 */
  index: number
  /** 航段名称 */
  name: string
  /** 航点描述 */
  point: string
  /** 是否已上传成功：失败重试时已传航段跳过，从第一个缺失航段继续。 */
  uploaded: boolean
}

export interface AnomalyItem {
  /** 架次内异常序号，从 1 开始。 */
  no: number
  description: string
  location: string
}

export interface Sortie {
  /** 业务幂等键：`任务id-架次号`，重复上传同一架次据此识别。 */
  id: string
  taskId: number
  /** 架次号（同一任务内从 1 递增）。 */
  sortieNo: number
  /** 实际上传使用的飞行区域（为空时已按规则补齐并落库）。 */
  area: string
  route: string
  pilotName: string
  /** 原始起降时间：创建架次时写入，续传、重传都不再改动。 */
  takeoffAt: string
  landingAt: string
  segments: TrackSegment[]
  /** 飞手端随架次上报的原始异常（报告由服务端单向提交后才有）。 */
  anomalies: AnomalyItem[]
  status: SortieStatus
  uploadedAt: string | null
  /** 失败时第一个未传成功的航段序号。 */
  failAtSegment: number | null
}

/** 异常报告：只能提交产生，不能撤回、不能改、不能因重传再生成。 */
export interface AnomalyReport {
  id: string
  sortieId: string
  taskId: number
  anomalyNo: number
  description: string
  location: string
  area: string
  pilotName: string
  reportedAt: string
  /** 恒为 true：异常单向提交，落库即终态。 */
  submitted: boolean
}

/** 核查提醒：一份异常报告对应一条待办，按业务键去重，空航迹不产生。 */
export interface Reminder {
  id: string
  taskId: number
  sortieId: string
  reportId: string
  title: string
  detail: string
  createdAt: string
  resolved: boolean
  resolvedAt: string | null
}

export interface DroneDB {
  pilots: Pilot[]
  tasks: DroneTask[]
  sorties: Sortie[]
  reports: AnomalyReport[]
  reminders: Reminder[]
}
