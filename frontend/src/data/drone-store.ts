import { allRows, saveRows } from './local-store'
import type { CheckReminder, DronePilot, DroneSortie } from './drone-types'
import type { EntryRow } from './types'

// 无人机域独立持久化：与通用清单存储分开，换骨架（接回后端）时这层直接替换成接口。
const DRONE_STORAGE_KEY = 'forest-fire-patrol:drone-domain:v1'

export type DroneDomain = {
  pilots: DronePilot[]
  sorties: DroneSortie[]
  reminders: CheckReminder[]
  /** 已在通用 firereport 清单里播种的报告编号，避免重复播种。 */
  seededReports: string[]
}

const TODAY = '2026-10-04'

function seedPilots(): DronePilot[] {
  return [
    { id: 1, 姓名: '李远航', 工号: 'PILOT-011', 联系方式: '13800000111', 所属林场: '青峰林场', 资质编号: 'UAV-A-2024-011', 状态: '在册' },
    { id: 2, 姓名: '周慕云', 工号: 'PILOT-024', 联系方式: '13800000222', 所属林场: '云栖林场', 资质编号: 'UAV-A-2024-024', 状态: '在册' },
    { id: 3, 姓名: '陈岭', 工号: 'PILOT-031', 联系方式: '13800000333', 所属林场: '青峰林场', 资质编号: 'UAV-B-2023-031', 状态: '在册' },
    { id: 4, 姓名: '赵雁回', 工号: 'PILOT-042', 联系方式: '13800000444', 所属林场: '白桦林场', 资质编号: 'UAV-A-2025-042', 状态: '停飞' },
  ]
}

function seg(
  seq: number,
  region: string,
  abnormal: number,
  start = `${TODAY} 09:00`,
  end = `${TODAY} 09:20`,
) {
  return { seq, 起飞时间: start, 降落时间: end, 飞行区域: region, 航点: `WP-${seq}1,WP-${seq}2`, 异常数: abnormal }
}

function seedSorties(): DroneSortie[] {
  // DRON-0002：上传到第 3 段中断，缺失 4-5 段，正好演示失败后从缺失航段续传。
  const partialSegs = [seg(1, '北坡防火线', 0), seg(2, '北坡防火线', 1), seg(3, '', 0)].map((item) => ({
    ...item,
    区域补齐: item.seq === 3,
    飞行区域: item.seq === 3 ? '北坡防火线（沿用上段补齐）' : item.飞行区域,
  }))
  // DRON-0003：完整架次，发现 2 处异常，已生成报告与待核查提醒。
  const doneSegs = [seg(1, '东沟瞭望塔', 0, `${TODAY} 08:05`, `${TODAY} 08:25`), seg(2, '东沟瞭望塔', 2, `${TODAY} 08:25`, `${TODAY} 08:47`)]
    .map((item) => ({ ...item, 区域补齐: false }))
  // DRON-0004：任务已中止，航迹只传了 4 段中的 2 段，中止时已有 1 处异常 → 生成报告与提醒，但任务保持「因故中止」。
  const abortedSegs = [seg(1, '西岗营林区', 1, `${TODAY} 14:10`, `${TODAY} 14:30`), seg(2, '西岗营林区', 0, `${TODAY} 14:30`, `${TODAY} 14:48`)]
    .map((item) => ({ ...item, 区域补齐: false }))

  return [
    {
      id: 1,
      架次编号: 'SORT-0001',
      任务编号: 'DRON-0002',
      飞手id: 1,
      飞手姓名: '李远航',
      总段数: 5,
      已接收段: [1, 2, 3],
      航段: partialSegs,
      原始起飞时间: `${TODAY} 09:00`,
      原始降落时间: '',
      异常数: 1,
      已提交异常: false,
      关联报告编号: '',
      关联提醒id: 0,
      完成声明: false,
      已收口: false,
      完成时间: '',
      创建时间: `${TODAY} 08:58:11`,
      最近上传时间: `${TODAY} 09:31:42`,
      最近批次: 1,
      上传日志: [
        { 时间: `${TODAY} 09:10:00`, 批次: 1, 接收段: [1, 2, 3], 结果: '部分接收，缺失航段：4、5' },
      ],
    },
    {
      id: 2,
      架次编号: 'SORT-0002',
      任务编号: 'DRON-0003',
      飞手id: 2,
      飞手姓名: '周慕云',
      总段数: 2,
      已接收段: [1, 2],
      航段: doneSegs,
      原始起飞时间: `${TODAY} 08:05`,
      原始降落时间: `${TODAY} 08:47`,
      异常数: 2,
      已提交异常: true,
      关联报告编号: 'FIRE-DRON-0003',
      关联提醒id: 1,
      完成声明: true,
      已收口: true,
      完成时间: `${TODAY} 08:50:03`,
      创建时间: `${TODAY} 08:02:40`,
      最近上传时间: `${TODAY} 08:49:55`,
      最近批次: 2,
      上传日志: [
        { 时间: `${TODAY} 08:30:00`, 批次: 1, 接收段: [1], 结果: '部分接收，缺失航段：2' },
        { 时间: `${TODAY} 08:49:55`, 批次: 2, 接收段: [2], 结果: '航迹齐全，异常已单向提交（2 处）' },
      ],
    },
    {
      id: 3,
      架次编号: 'SORT-0003',
      任务编号: 'DRON-0004',
      飞手id: 3,
      飞手姓名: '陈岭',
      总段数: 4,
      已接收段: [1, 2],
      航段: abortedSegs,
      原始起飞时间: `${TODAY} 14:10`,
      原始降落时间: '',
      异常数: 1,
      已提交异常: true,
      关联报告编号: 'FIRE-DRON-0004',
      关联提醒id: 2,
      完成声明: false,
      已收口: false,
      完成时间: '',
      创建时间: `${TODAY} 14:05:20`,
      最近上传时间: `${TODAY} 14:50:00`,
      最近批次: 1,
      上传日志: [
        { 时间: `${TODAY} 14:50:00`, 批次: 1, 接收段: [1, 2], 结果: '部分接收，缺失航段：3、4' },
        { 时间: `${TODAY} 15:02:00`, 批次: 2, 接收段: [], 结果: '任务因故中止，已有异常单向提交，状态不再回退' },
      ],
    },
  ]
}

function seedReminders(): CheckReminder[] {
  return [
    {
      id: 1,
      提醒编号: 'CHK-0001',
      任务编号: 'DRON-0003',
      架次编号: 'SORT-0002',
      飞手姓名: '周慕云',
      飞行区域: '东沟瞭望塔',
      异常数: 2,
      发现时间: `${TODAY} 08:47:00`,
      状态: '待核查',
      核查人: '',
      核查时间: '',
      核查结论: '',
    },
    {
      id: 2,
      提醒编号: 'CHK-0002',
      任务编号: 'DRON-0004',
      架次编号: 'SORT-0003',
      飞手姓名: '陈岭',
      飞行区域: '西岗营林区',
      异常数: 1,
      发现时间: `${TODAY} 14:30:00`,
      状态: '待核查',
      核查人: '',
      核查时间: '',
      核查结论: '',
    },
  ]
}

// 与域数据联动的火情报告播种：只补一次，后续由航迹提交事务生成。
function seedLinkedReports(domain: DroneDomain): void {
  const reports = allRows()['firereport'] ?? []
  const linked: Array<[string, string, string, string]> = [
    ['FIRE-DRON-0003', '东沟瞭望塔', `${TODAY} 08:47`, '周慕云'],
    ['FIRE-DRON-0004', '西岗营林区', `${TODAY} 14:30`, '陈岭'],
  ]
  const additions: EntryRow[] = []
  for (const [编号, 地点, 时间, 报告人] of linked) {
    if (domain.seededReports.includes(编号)) {
      continue
    }
    if (reports.some((row) => String(row['报告编号']) === 编号)) {
      domain.seededReports.push(编号)
      continue
    }
    const id = reports.length + additions.length + 1
    additions.push({
      id,
      status: '待核实',
      pending: true,
      abnormal: true,
      报告编号: 编号,
      起火地点: `无人机巡查发现：${地点}`,
      起火时间: 时间,
      火势等级: '待现场判定',
      过火面积: '待核',
      扑救情况: '等待核查反馈',
      报告人: `无人机飞手 ${报告人}`,
      报告状态: '待核实',
    })
    domain.seededReports.push(编号)
  }
  if (additions.length > 0) {
    saveRows('firereport', [...reports, ...additions])
  }
}

function buildSeed(): DroneDomain {
  return {
    pilots: seedPilots(),
    sorties: seedSorties(),
    reminders: seedReminders(),
    seededReports: [],
  }
}

let domainCache: DroneDomain | null = null

function readDomain(): DroneDomain {
  const fallback = buildSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    seedLinkedReports(fallback)
    return fallback
  }
  const raw = window.localStorage.getItem(DRONE_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(DRONE_STORAGE_KEY, JSON.stringify(fallback))
    seedLinkedReports(fallback)
    persistDomain(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as DroneDomain
    const domain: DroneDomain = {
      pilots: parsed.pilots ?? fallback.pilots,
      sorties: parsed.sorties ?? fallback.sorties,
      reminders: parsed.reminders ?? fallback.reminders,
      seededReports: parsed.seededReports ?? [],
    }
    seedLinkedReports(domain)
    return domain
  } catch {
    window.localStorage.setItem(DRONE_STORAGE_KEY, JSON.stringify(fallback))
    seedLinkedReports(fallback)
    persistDomain(fallback)
    return fallback
  }
}

export function persistDomain(domain: DroneDomain): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(DRONE_STORAGE_KEY, JSON.stringify(domain))
  }
}

export function droneDomain(): DroneDomain {
  if (domainCache === null) {
    domainCache = readDomain()
  }
  return domainCache
}

export function saveDroneDomain(mutate: (domain: DroneDomain) => void): DroneDomain {
  const domain = droneDomain()
  mutate(domain)
  persistDomain(domain)
  return domain
}

// 无人机模块重置：域数据与联动的火情报告一起回到示例态。
export function resetDroneDomain(): DroneDomain {
  domainCache = buildSeed()
  persistDomain(domainCache)
  seedLinkedReports(domainCache)
  return domainCache
}
