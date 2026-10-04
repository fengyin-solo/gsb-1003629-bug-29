import { DRONE_SEED } from './seed'
import type { DroneDB } from './types'

// 无人机巡查专用持久化键，与通用条目桶（forest-fire-patrol:entries）分开，避免两套数据互相覆盖。
const DRONE_STORAGE_KEY = 'forest-fire-patrol:drone'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readDB(): DroneDB {
  const fallback = clone(DRONE_SEED)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(DRONE_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(DRONE_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DroneDB>
    // 老版本缓存缺集合时用初始数据补齐，保证结构完整。
    return {
      pilots: parsed.pilots ?? clone(fallback.pilots),
      tasks: parsed.tasks ?? clone(fallback.tasks),
      sorties: parsed.sorties ?? clone(fallback.sorties),
      reports: parsed.reports ?? clone(fallback.reports),
      reminders: parsed.reminders ?? clone(fallback.reminders),
    }
  } catch {
    window.localStorage.setItem(DRONE_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: DroneDB | null = null

export function droneDB(): DroneDB {
  if (cache === null) {
    cache = readDB()
  }
  return cache
}

/** 服务层在克隆数据上完成整笔事务后统一提交：失败不调用此函数，库里仍是旧值。 */
export function commitDB(next: DroneDB): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(DRONE_STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetDroneDB(): DroneDB {
  const fresh = clone(DRONE_SEED)
  commitDB(fresh)
  return fresh
}

export function droneStorageKey(): string {
  return DRONE_STORAGE_KEY
}
