<template>
  <section class="page" data-module="drone">
    <header class="page-head">
      <div>
        <h2>无人机巡查管理</h2>
        <p class="page-desc">沿「飞手 → 任务 → 架次航段 → 异常 → 火情报告/核查提醒」数据流登记与上传；异常单向提交、同架次只生效一次、失败从缺失航段续传。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openUpload()">上传航迹</button>
        <button class="btn" type="button" @click="exportRows">导出巡查清单</button>
        <button class="btn ghost" type="button" @click="handleReset">重置示例数据</button>
      </div>
    </header>

    <div class="tab-row">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}
        <em v-if="tab.key === 'reminders' && pendingReminderCount" class="tab-badge">{{ pendingReminderCount }}</em>
      </button>
    </div>

    <!-- 任务列表 -->
    <div v-if="activeTab === 'tasks'">
      <div class="stat-row">
        <article v-for="item in statCards" :key="item.label" class="stat-card">
          <span class="stat-label">{{ item.label }}</span>
          <strong class="stat-value">{{ item.value }}</strong>
        </article>
      </div>

      <p class="status-legend">
        <span v-for="item in summary" :key="item.status" class="legend-item">
          {{ item.status }}：{{ item.count }}
        </span>
      </p>

      <form class="filter-bar" @submit.prevent="reload">
        <label v-for="field in filterFields" :key="field" class="filter-item">
          <span>{{ field }}</span>
          <input v-model="filters[field]" :placeholder="`按${field}检索`" />
        </label>
        <button class="btn" type="submit">查询</button>
        <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      </form>

      <p v-if="listBanner" class="result-banner" :class="listBanner.ok ? 'ok' : 'err'">{{ listBanner.text }}</p>

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in taskColumns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in taskColumns" :key="column">
              <template v-if="column === '飞行区域'">
                {{ row[column] || '—' }}
                <span v-if="row['区域补齐']" class="tag tag-patch">系统补标</span>
              </template>
              <template v-else-if="column === '发现异常数'">
                <span :class="Number(row[column]) > 0 ? 'abnormal-num' : ''">{{ row[column] ?? 0 }}</span>
              </template>
              <template v-else>{{ row[column] || '—' }}</template>
            </td>
            <td>
              <span class="status-dot" :data-status="String(row.status)"></span>{{ row.status }}
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="runAction('开始飞行', row)">开始飞行</button>
              <button class="link" type="button" @click="runAction('确认完成', row)">确认完成</button>
              <button class="link danger" type="button" @click="runAction('中止任务', row)">中止任务</button>
              <button class="link" type="button" @click="openUpload(String(row['任务编号']))">上传航迹</button>
              <button class="link" type="button" @click="openDetail(String(row['任务编号']))">航迹详情</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="taskColumns.length + 2" class="empty-state">暂无符合条件的无人机巡查任务</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ rows.length }} 条无人机巡查记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </div>

    <!-- 航迹详情 -->
    <div v-else-if="activeTab === 'tracks'">
      <div class="filter-bar">
        <label class="filter-item">
          <span>按任务编号检索</span>
          <input v-model="trackFilter" placeholder="如 DRON-0002" />
        </label>
        <button class="btn ghost" type="button" @click="trackFilter = ''">清除</button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>架次编号</th><th>任务编号</th><th>飞手</th><th>航段进度</th><th>异常数</th>
            <th>原始起飞</th><th>原始降落</th><th>任务状态</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="sortie in filteredSorties" :key="sortie.架次编号">
            <td>{{ sortie.架次编号 }}</td>
            <td>{{ sortie.任务编号 }}</td>
            <td>{{ sortie.飞手姓名 }}</td>
            <td>
              <div class="progress">
                <div class="progress-bar" :style="{ width: progressPercent(sortie) + '%' }"></div>
              </div>
              <span class="progress-text">{{ sortie.已接收段.length }}/{{ sortie.总段数 }} 段
                <span v-if="missingOf(sortie).length" class="missing-seg">缺 {{ missingOf(sortie).join('、') }}</span>
                <span v-else-if="!sortie.已收口" class="missing-seg">待补提交</span>
              </span>
            </td>
            <td :class="sortie.异常数 > 0 ? 'abnormal-num' : ''">{{ sortie.异常数 }}</td>
            <td>{{ sortie.原始起飞时间 || '—' }}</td>
            <td>{{ sortie.原始降落时间 || '—' }}</td>
            <td>{{ taskStatusOf(sortie.任务编号) }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="openDetail(sortie.任务编号)">查看航迹</button>
              <button
                v-if="canResume(sortie)"
                class="link"
                type="button"
                @click="openUpload(sortie.任务编号, sortie.架次编号)"
              >
                {{ missingOf(sortie).length ? '从缺失航段续传' : '补做提交' }}
              </button>
            </td>
          </tr>
          <tr v-if="!filteredSorties.length">
            <td colspan="9" class="empty-state">暂无航迹记录，可在任务列表中上传航迹</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 核查提醒 -->
    <div v-else-if="activeTab === 'reminders'">
      <p class="page-tip">异常核查只能单向提交：提交后不可撤销、不可重复核查；空航迹不会生成提醒，同一架次只生成一条。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th>提醒编号</th><th>任务编号</th><th>架次编号</th><th>飞手</th><th>飞行区域</th>
            <th>异常数</th><th>发现时间</th><th>状态</th><th>核查</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="reminder in reminders" :key="reminder.id">
            <td>{{ reminder.提醒编号 }}</td>
            <td>{{ reminder.任务编号 }}</td>
            <td>{{ reminder.架次编号 }}</td>
            <td>{{ reminder.飞手姓名 }}</td>
            <td>{{ reminder.飞行区域 }}</td>
            <td class="abnormal-num">{{ reminder.异常数 }}</td>
            <td>{{ reminder.发现时间 }}</td>
            <td>
              <span class="status-dot" :data-status="reminder.状态 === '待核查' ? '飞行中' : '已完成'"></span>
              {{ reminder.状态 }}
            </td>
            <td>
              <button
                v-if="reminder.状态 === '待核查'"
                class="link"
                type="button"
                @click="startCheck(reminder.id)"
              >填写核查结论</button>
              <span v-else class="checked-info">
                {{ reminder.核查人 }} · {{ reminder.核查时间 }}<br />{{ reminder.核查结论 }}
              </span>
            </td>
          </tr>
          <tr v-if="!reminders.length">
            <td colspan="9" class="empty-state">暂无核查提醒</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 飞手花名册 -->
    <div v-else-if="activeTab === 'pilots'">
      <div class="register-box">
        <h3>登记飞手</h3>
        <div class="register-grid">
          <label class="filter-item"><span>姓名</span><input v-model="pilotForm.姓名" placeholder="飞手姓名" /></label>
          <label class="filter-item"><span>工号</span><input v-model="pilotForm.工号" placeholder="如 PILOT-050" /></label>
          <label class="filter-item"><span>联系方式</span><input v-model="pilotForm.联系方式" placeholder="手机号" /></label>
          <label class="filter-item"><span>所属林场</span><input v-model="pilotForm.所属林场" placeholder="所属林场" /></label>
          <label class="filter-item"><span>资质编号</span><input v-model="pilotForm.资质编号" placeholder="如 UAV-A-2025-050" /></label>
          <button class="btn primary" type="button" @click="submitPilot">登记入册</button>
        </div>
        <p v-if="pilotMessage" :class="pilotMessageOk ? 'ok-text' : 'error-text'">{{ pilotMessage }}</p>
      </div>
      <table class="data-table">
        <thead>
          <tr><th>姓名</th><th>工号</th><th>联系方式</th><th>所属林场</th><th>资质编号</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="pilot in pilots" :key="pilot.id">
            <td>{{ pilot.姓名 }}</td>
            <td>{{ pilot.工号 }}</td>
            <td>{{ pilot.联系方式 }}</td>
            <td>{{ pilot.所属林场 }}</td>
            <td>{{ pilot.资质编号 }}</td>
            <td>
              <span class="status-dot" :data-status="pilot.状态 === '在册' ? '已完成' : '因故中止'"></span>
              {{ pilot.状态 }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 航迹详情弹层 -->
    <div v-if="detailTaskNo" class="modal-mask" @click.self="detailTaskNo = ''">
      <div class="modal modal-wide">
        <header class="modal-head">
          <h3>航迹详情 · {{ detailTaskNo }}</h3>
          <button class="btn ghost" type="button" @click="detailTaskNo = ''">关闭</button>
        </header>
        <div v-if="detailTask" class="detail-grid">
          <div><span class="detail-label">飞行区域</span>{{ detailTask['飞行区域'] || '—' }}
            <span v-if="detailTask['区域补齐']" class="tag tag-patch">系统补标</span>
          </div>
          <div><span class="detail-label">飞手</span>{{ detailTask['飞手姓名'] || '—' }}</div>
          <div><span class="detail-label">任务状态</span>{{ detailTask.status }}</div>
          <div><span class="detail-label">发现异常数</span>{{ detailTask['发现异常数'] ?? 0 }}</div>
          <div><span class="detail-label">原始起飞时间</span>{{ detailTask['起飞时间'] || '—' }}</div>
          <div><span class="detail-label">原始降落时间</span>{{ detailTask['降落时间'] || '—' }}</div>
        </div>

        <div v-for="sortie in detailSorties" :key="sortie.架次编号" class="sortie-block">
          <header class="sortie-head">
            <strong>{{ sortie.架次编号 }}</strong>
            <span>{{ sortie.已接收段.length }}/{{ sortie.总段数 }} 段</span>
            <span v-if="sortie.已提交异常" class="tag tag-abnormal">异常 {{ sortie.异常数 }} 处已单向提交</span>
            <span v-if="sortie.已收口" class="tag tag-ok">已收口</span>
            <span v-else class="tag tag-missing">提交未完成</span>
            <button
              v-if="canResume(sortie)"
              class="btn"
              type="button"
              @click="resumeFromDetail(sortie)"
            >{{ missingOf(sortie).length ? `续传缺失航段 ${missingOf(sortie).join('、')}` : '补做提交' }}</button>
          </header>
          <table class="data-table sub-table">
            <thead>
              <tr><th>航段</th><th>起飞时间</th><th>降落时间</th><th>飞行区域</th><th>航点</th><th>异常数</th></tr>
            </thead>
            <tbody>
              <tr v-for="seg in buildSegmentRows(sortie)" :key="seg.seq" :class="{ 'seg-missing': seg.missing }">
                <td>第 {{ seg.seq }} 段 <span v-if="seg.missing" class="tag tag-missing">缺失</span></td>
                <td>{{ seg.起飞时间 || '—' }}</td>
                <td>{{ seg.降落时间 || '—' }}</td>
                <td>
                  {{ seg.飞行区域 || '—' }}
                  <span v-if="seg.区域补齐" class="tag tag-patch">区域补齐</span>
                </td>
                <td>{{ seg.航点 || '—' }}</td>
                <td :class="seg.异常数 > 0 ? 'abnormal-num' : ''">{{ seg.异常数 }}</td>
              </tr>
            </tbody>
          </table>
          <ul class="upload-log">
            <li v-for="(log, i) in sortie.上传日志" :key="i">
              <span class="log-time">{{ log.时间 }}</span> 第 {{ log.批次 }} 批 · 接收 [{{ log.接收段.join('、') || '无' }}] · {{ log.结果 }}
            </li>
          </ul>
        </div>
        <p v-if="!detailSorties.length" class="empty-state">该任务暂无航迹，先上传航迹后再核对</p>
      </div>
    </div>

    <!-- 上传航迹弹窗 -->
    <div v-if="uploadOpen" class="modal-mask" @click.self="closeUpload">
      <div class="modal modal-wide">
        <header class="modal-head">
          <h3>上传航迹{{ uploadPrefillNote ? `（${uploadPrefillNote}）` : '' }}</h3>
          <button class="btn ghost" type="button" @click="closeUpload">返回列表</button>
        </header>

        <div class="upload-grid">
          <label class="filter-item">
            <span>任务编号</span>
            <select v-model="uploadForm.任务编号" :disabled="Boolean(uploadForm.任务编号)">
              <option value="" disabled>选择任务</option>
              <option v-for="task in rows" :key="String(task.id)" :value="String(task['任务编号'])">
                {{ task['任务编号'] }}（{{ task.status }}）
              </option>
            </select>
          </label>
          <label class="filter-item">
            <span>架次编号</span>
            <input v-model="uploadForm.架次编号" placeholder="同一架次重传用同一编号" />
          </label>
          <label class="filter-item">
            <span>飞手</span>
            <select v-model="uploadForm.飞手姓名">
              <option value="" disabled>选择在册飞手</option>
              <option v-for="pilot in activePilots" :key="pilot.id" :value="pilot.姓名">
                {{ pilot.姓名 }}（{{ pilot.所属林场 }}）
              </option>
            </select>
          </label>
          <label class="filter-item">
            <span>计划航段总数</span>
            <input v-model.number="uploadForm.总段数" type="number" min="1" />
          </label>
        </div>

        <table class="data-table sub-table">
          <thead>
            <tr><th>航段序号</th><th>起飞时间</th><th>降落时间</th><th>飞行区域（可空）</th><th>航点</th><th>异常数</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="(seg, i) in uploadForm.航段" :key="i">
              <td><input v-model.number="seg.seq" type="number" min="1" class="cell-input" /></td>
              <td><input v-model="seg.起飞时间" placeholder="如 2026-10-04 10:00" class="cell-input" /></td>
              <td><input v-model="seg.降落时间" placeholder="如 2026-10-04 10:25" class="cell-input" /></td>
              <td><input v-model="seg.飞行区域" placeholder="留空由系统补齐" class="cell-input" /></td>
              <td><input v-model="seg.航点" placeholder="如 WP-1,WP-2" class="cell-input" /></td>
              <td><input v-model.number="seg.异常数" type="number" min="0" class="cell-input narrow" /></td>
              <td><button class="link danger" type="button" @click="uploadForm.航段.splice(i, 1)">删除</button></td>
          </tr>
          </tbody>
        </table>
        <div class="upload-actions">
          <button class="btn" type="button" @click="addSegmentRow">加一行航段</button>
          <label class="check-line">
            <input v-model="uploadForm.完成声明" type="checkbox" /> 本次为最后一批，航段齐全即完成任务
          </label>
          <label class="check-line">
            <input v-model="uploadForm.强制失败" type="checkbox" /> 模拟提交失败（验证三侧回退与缺失航段续传）
          </label>
        </div>

        <p v-if="uploadResult" class="result-banner" :class="uploadResult.ok ? 'ok' : 'err'">
          {{ uploadResult.message }}
          <template v-if="uploadResult.生成报告"> · 已生成火情报告 {{ uploadResult.生成报告 }}</template>
          <template v-if="uploadResult.生成提醒"> · 已生成核查提醒 {{ uploadResult.生成提醒 }}</template>
        </p>

        <footer class="modal-foot">
          <button class="btn" type="button" @click="closeUpload">返回列表</button>
          <button class="btn primary" type="button" :class="{ busy: submitting }" @click="submitUpload">
            {{ submitting ? '提交中…（再点一次会被拒绝）' : '提交航迹' }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 核查结论弹窗 -->
    <div v-if="checkingReminderId" class="modal-mask" @click.self="checkingReminderId = 0">
      <div class="modal">
        <header class="modal-head">
          <h3>核查结论 · 提醒 {{ checkingReminderId }}</h3>
          <button class="btn ghost" type="button" @click="checkingReminderId = 0">关闭</button>
        </header>
        <p class="page-tip">提交后状态单向变为「已核查」，不可撤销、不可重复提交。</p>
        <textarea v-model="checkConclusion" rows="4" class="conclusion-input" placeholder="请填写现场核查结论"></textarea>
        <p v-if="checkError" class="error-text">{{ checkError }}</p>
        <footer class="modal-foot">
          <button class="btn" type="button" @click="checkingReminderId = 0">取消</button>
          <button class="btn primary" type="button" @click="submitCheck">单向提交核查</button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  checkReminder,
  droneStats,
  isUploading,
  listPilots,
  listReminders,
  listSorties,
  listTasks,
  registerPilot,
  resetDrone,
  statusSummary,
  transitionTask,
  uploadTrack,
} from '@/api/drone-service'
import type { CheckReminder, DronePilot, DroneSortie, StoredSegment, UploadTrackResult } from '@/data/drone-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('drone')
const tabs = [
  { key: 'tasks', label: '任务列表' },
  { key: 'tracks', label: '航迹详情' },
  { key: 'reminders', label: '核查提醒' },
  { key: 'pilots', label: '飞手花名册' },
] as const
type TabKey = (typeof tabs)[number]['key']

const activeTab = ref<TabKey>('tasks')
const taskColumns = ['任务编号', '飞行区域', '飞行路线', '飞手姓名', '起飞时间', '降落时间', '发现异常数']
const filterFields = ['任务编号', '飞行区域', '飞行路线']

const rows = ref<EntryRow[]>([])
const sorties = ref<DroneSortie[]>([])
const reminders = ref<CheckReminder[]>([])
const pilots = ref<DronePilot[]>([])
const filters = reactive<Record<string, string>>({})
const errorMessage = ref('')
const listBanner = ref<{ ok: boolean; text: string } | null>(null)
const trackFilter = ref('')

const statCards = ref([
  { label: '今日飞行任务', value: 0 },
  { label: '已完成任务', value: 0 },
  { label: '发现异常数', value: 0 },
])
const summary = ref(statusSummary())

const activePilots = computed(() => pilots.value.filter((p) => p.状态 === '在册'))
const pendingReminderCount = computed(() => reminders.value.filter((r) => r.状态 === '待核查').length)
const filteredSorties = computed(() =>
  sorties.value.filter((s) => !trackFilter.value || s.任务编号.includes(trackFilter.value.trim())),
)

function missingOf(sortie: DroneSortie): number[] {
  const owned = new Set(sortie.已接收段)
  const result: number[] = []
  for (let i = 1; i <= sortie.总段数; i += 1) {
    if (!owned.has(i)) {
      result.push(i)
    }
  }
  return result
}

function progressPercent(sortie: DroneSortie): number {
  if (sortie.总段数 === 0) {
    return 0
  }
  return Math.round((sortie.已接收段.length / sortie.总段数) * 100)
}

function taskStatusOf(taskNo: string): string {
  return rows.value.find((r) => String(r['任务编号']) === taskNo)?.status ?? '—'
}

// 可续传/补提交：未收口，且任务不是非中止的终态（已完成正常情况下即已收口）。
function canResume(sortie: DroneSortie): boolean {
  if (sortie.已收口) {
    return false
  }
  return true
}

function refreshAll() {
  rows.value = listTasks(filters)
  sorties.value = listSorties()
  reminders.value = listReminders()
  pilots.value = listPilots()
  const stats = droneStats()
  statCards.value = [
    { label: '今日飞行任务', value: stats.今日飞行任务 },
    { label: '已完成任务', value: stats.已完成任务 },
    { label: '发现异常数', value: stats.发现异常数 },
  ]
  summary.value = statusSummary()
}

function reload() {
  errorMessage.value = ''
  try {
    refreshAll()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无人机巡查数据读取失败'
  }
}

function resetFilters() {
  for (const key of Object.keys(filters)) {
    filters[key] = ''
  }
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function switchTab(key: TabKey) {
  activeTab.value = key
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  listBanner.value = null
  const result = transitionTask(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    listBanner.value = { ok: false, text: result.message }
    return
  }
  listBanner.value = { ok: true, text: result.message }
  reload()
}

function handleReset() {
  const result = resetDrone()
  listBanner.value = { ok: result.ok, text: result.message }
  if (result.ok) {
    reload()
  }
}

// ---------- 航迹详情 ----------

const detailTaskNo = ref('')
const detailTask = computed(() => rows.value.find((r) => String(r['任务编号']) === detailTaskNo.value))
const detailSorties = computed(() => listSorties(detailTaskNo.value))

function openDetail(taskNo: string) {
  reload()
  detailTaskNo.value = taskNo
}

type SegmentRowView = (StoredSegment | { seq: number; 起飞时间: string; 降落时间: string; 飞行区域: string; 航点: string; 异常数: number; 区域补齐: boolean }) & { missing?: boolean }

function buildSegmentRows(sortie: DroneSortie): SegmentRowView[] {
  const bySeq = new Map(sortie.航段.map((s) => [s.seq, s]))
  const result: SegmentRowView[] = []
  for (let seq = 1; seq <= sortie.总段数; seq += 1) {
    const found = bySeq.get(seq)
    if (found) {
      result.push({ ...found })
    } else {
      result.push({ seq, 起飞时间: '', 降落时间: '', 飞行区域: '', 航点: '', 异常数: 0, 区域补齐: false, missing: true })
    }
  }
  return result
}

// ---------- 上传航迹 ----------

type SegmentForm = { seq: number | null; 起飞时间: string; 降落时间: string; 飞行区域: string; 航点: string; 异常数: number | null }
type UploadForm = {
  任务编号: string
  架次编号: string
  飞手姓名: string
  总段数: number | null
  完成声明: boolean
  强制失败: boolean
  航段: SegmentForm[]
}

const uploadOpen = ref(false)
const submitting = ref(false)
const uploadResult = ref<UploadTrackResult | null>(null)
const uploadPrefillNote = ref('')
const checkingReminderId = ref(0)
const checkConclusion = ref('')
const checkError = ref('')

function emptySegment(seq = 1): SegmentForm {
  return { seq, 起飞时间: '', 降落时间: '', 飞行区域: '', 航点: '', 异常数: 0 }
}

function defaultSortieNo(): string {
  const next = listSorties().length + 1
  return `SORT-${String(next).padStart(4, '0')}`
}

function openUpload(taskNo = '', sortieNo = '') {
  reload()
  listBanner.value = null
  uploadResult.value = null
  uploadPrefillNote.value = ''
  const form: UploadForm = {
    任务编号: taskNo,
    架次编号: sortieNo || defaultSortieNo(),
    飞手姓名: '',
    总段数: null,
    完成声明: false,
    强制失败: false,
    航段: [emptySegment(1)],
  }
  if (taskNo) {
    const task = rows.value.find((r) => String(r['任务编号']) === taskNo)
    if (task) {
      form.飞手姓名 = String(task['飞手姓名'] ?? '')
    }
  }
  if (sortieNo) {
    const sortie = listSorties().find((s) => s.架次编号 === sortieNo)
    if (sortie) {
      form.任务编号 = sortie.任务编号
      form.飞手姓名 = sortie.飞手姓名
      form.总段数 = sortie.总段数
      const missing = missingOf(sortie)
      if (missing.length) {
        form.航段 = missing.map((seq) => emptySegment(seq))
        form.完成声明 = missing.length + sortie.已接收段.length === sortie.总段数
        uploadPrefillNote.value = `从缺失航段 ${missing.join('、')} 续传`
      } else {
        // 航段齐但上次事务失败回退：带齐已接收段重传（航段幂等跳过），只补做提交。
        form.航段 = sortie.航段.map((s) => ({
          seq: s.seq,
          起飞时间: s.起飞时间,
          降落时间: s.降落时间,
          飞行区域: s.飞行区域,
          航点: s.航点,
          异常数: s.异常数,
        }))
        form.完成声明 = true
        uploadPrefillNote.value = '航段已齐、上次提交未收口，本次补做提交（已接收航段幂等跳过）'
      }
    }
  }
  uploadFormInit(form)
  uploadOpen.value = true
}

const uploadForm = reactive<UploadForm>({
  任务编号: '',
  架次编号: '',
  飞手姓名: '',
  总段数: null,
  完成声明: false,
  强制失败: false,
  航段: [],
})

function uploadFormInit(form: UploadForm) {
  Object.assign(uploadForm, form)
}

function resumeFromDetail(sortie: DroneSortie) {
  detailTaskNo.value = ''
  openUpload(sortie.任务编号, sortie.架次编号)
}

function addSegmentRow() {
  const used = new Set(uploadForm.航段.map((s) => s.seq).filter((v): v is number => typeof v === 'number'))
  let seq = 1
  while (used.has(seq)) {
    seq += 1
  }
  uploadForm.航段.push(emptySegment(seq))
}

async function submitUpload() {
  // 不在这里加锁防重点：服务端有提交锁，快速连点正好验证「并发第二次提交被拒绝」。
  const segs = uploadForm.航段
    .filter((s) => typeof s.seq === 'number')
    .map((s) => ({
      seq: Number(s.seq),
      起飞时间: s.起飞时间.trim(),
      降落时间: s.降落时间.trim(),
      飞行区域: s.飞行区域.trim(),
      航点: s.航点.trim(),
      异常数: Number(s.异常数 ?? 0),
    }))
  submitting.value = true
  try {
    const result = await uploadTrack({
      任务编号: uploadForm.任务编号,
      架次编号: uploadForm.架次编号.trim(),
      飞手姓名: uploadForm.飞手姓名,
      总段数: Number(uploadForm.总段数 ?? 0),
      完成声明: uploadForm.完成声明,
      航段: segs,
      强制失败: uploadForm.强制失败,
    })
    uploadResult.value = result
    reload()
    // 失败后：已接收段保留、缺失段回填到表单，返回列表再进来仍是同一续传现场。
    if (!result.ok && result.架次编号) {
      const sortie = listSorties().find((s) => s.架次编号 === result.架次编号)
      if (sortie) {
        uploadForm.总段数 = sortie.总段数
        uploadForm.航段 = result.缺失段.map((seq) => emptySegment(seq))
        uploadPrefillNote.value = `提交已回退，缺失航段 ${result.缺失段.join('、')} 已重新列出`
      }
    }
  } finally {
    submitting.value = false
  }
}

function closeUpload() {
  if (isUploading()) {
    listBanner.value = { ok: false, text: '航迹仍在提交中，请等待本次上传结束' }
    return
  }
  uploadOpen.value = false
  uploadResult.value = null
  reload()
}

// ---------- 核查提醒 ----------

function startCheck(id: number) {
  checkingReminderId.value = id
  checkConclusion.value = ''
  checkError.value = ''
}

function submitCheck() {
  const result = checkReminder(checkingReminderId.value, checkConclusion.value, '值班管理员')
  if (!result.ok) {
    checkError.value = result.message
    return
  }
  checkingReminderId.value = 0
  reload()
}

// ---------- 飞手登记 ----------

const pilotForm = reactive({ 姓名: '', 工号: '', 联系方式: '', 所属林场: '', 资质编号: '' })
const pilotMessage = ref('')
const pilotMessageOk = ref(false)

function submitPilot() {
  const result = registerPilot({ ...pilotForm })
  pilotMessage.value = result.message
  pilotMessageOk.value = result.ok
  if (result.ok) {
    pilotForm.姓名 = ''
    pilotForm.工号 = ''
    pilotForm.联系方式 = ''
    pilotForm.所属林场 = ''
    pilotForm.资质编号 = ''
    reload()
  }
}

onMounted(reload)
</script>

<style scoped>
.tab-row { display: flex; gap: 8px; margin: 8px 0 14px; }
.tab-btn { position: relative; border: 1px solid var(--border); background: #fff; border-radius: 6px 6px 0 0; padding: 8px 16px; cursor: pointer; font-size: 13px; color: var(--muted); }
.tab-btn.active { background: var(--brand); border-color: var(--brand); color: #fff; }
.tab-badge { font-style: normal; background: #d92d20; color: #fff; border-radius: 999px; font-size: 11px; padding: 0 7px; margin-left: 6px; }
.abnormal-num { color: #b42318; font-weight: 600; }
.link.danger { color: #b42318; }
.tag { display: inline-block; border-radius: 4px; font-size: 11px; padding: 0 6px; margin-left: 4px; }
.tag-patch { background: #fff4e5; color: #b54708; border: 1px solid #fedf89; }
.tag-abnormal { background: #fef3f2; color: #b42318; border: 1px solid #fecdca; }
.tag-missing { background: #fef3f2; color: #b42318; }
.tag-ok { background: #ecfdf3; color: #027a48; border: 1px solid #abefc6; }
.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: #98a2b3; }
.status-dot[data-status='飞行中'] { background: #f79009; }
.status-dot[data-status='已完成'] { background: #12b76a; }
.status-dot[data-status='因故中止'] { background: #b42318; }
.status-dot[data-status='待执行'] { background: #98a2b3; }
.result-banner { border-radius: 6px; padding: 8px 12px; font-size: 13px; }
.result-banner.ok { background: #ecfdf3; border: 1px solid #abefc6; color: #027a48; }
.result-banner.err { background: #fef3f2; border: 1px solid #fecdca; color: #b42318; }
.page-tip { font-size: 12px; color: var(--muted); background: #eef2f7; border-radius: 6px; padding: 8px 12px; }
.progress { width: 120px; height: 8px; background: #e4e7ec; border-radius: 999px; overflow: hidden; }
.progress-bar { height: 100%; background: var(--brand); }
.progress-text { font-size: 12px; color: var(--muted); }
.missing-seg { color: #b42318; margin-left: 4px; }
.register-box { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; }
.register-box h3 { margin: 0 0 10px; font-size: 14px; }
.register-grid { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.register-grid .btn { height: 32px; }
.ok-text { color: #027a48; font-size: 12px; }
.modal-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45); display: flex; align-items: flex-start; justify-content: center; z-index: 50; padding: 32px 16px; overflow: auto; }
.modal { background: #fff; border-radius: 10px; width: 560px; max-width: 100%; padding: 16px 20px; box-shadow: 0 20px 48px rgba(16, 24, 40, 0.2); }
.modal-wide { width: 960px; }
.modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.modal-head h3 { margin: 0; font-size: 15px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; font-size: 13px; margin-bottom: 14px; }
.detail-label { display: block; font-size: 11px; color: var(--muted); }
.sortie-block { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
.sortie-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 13px; }
.sub-table { font-size: 12px; }
.seg-missing { background: #fef9f8; color: var(--muted); }
.upload-log { margin: 8px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); }
.log-time { color: #475467; }
.upload-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 10px; }
.cell-input { width: 100%; border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px; font-size: 12px; }
.cell-input.narrow { width: 70px; }
.upload-actions { display: flex; align-items: center; gap: 16px; margin: 10px 0; flex-wrap: wrap; }
.check-line { font-size: 12px; color: #475467; display: flex; align-items: center; gap: 4px; }
.btn.busy { opacity: 0.8; }
.conclusion-input { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 13px; resize: vertical; }
.checked-info { font-size: 12px; color: var(--muted); }
</style>
