<template>
  <section class="page" data-module="drone">
    <header class="page-head">
      <div>
        <h2>无人机巡查管理</h2>
        <p class="page-desc">飞手 → 任务 → 架次航迹 → 异常报告 → 核查提醒 一条链：状态、异常数与待办全部同源。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出无人机巡查清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="switchTab(tab.key)"
      >
        {{ tab.label }}<span v-if="tab.badge" class="tab-badge">{{ tab.badge }}</span>
      </button>
    </div>

    <!-- 任务列表 -->
    <template v-if="activeTab === 'tasks'">
      <p class="status-legend">
        <span v-for="item in statusSummary" :key="item.status" class="legend-item">
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

      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ display(row, column) }}</td>
            <td class="row-actions">
              <button v-if="row.status === '待执行'" class="link" type="button" @click="runAction('开始飞行', row)">
                开始飞行
              </button>
              <button v-if="row.status === '飞行中'" class="link" type="button" @click="runAction('确认完成', row)">
                确认完成
              </button>
              <button
                v-if="row.status === '待执行' || row.status === '飞行中'"
                class="link"
                type="button"
                @click="runAction('中止任务', row)"
              >
                中止任务
              </button>
              <button class="link" type="button" @click="goUpload(row.id)">上传/续传架次</button>
              <button class="link" type="button" @click="goTrack(row.id)">查看航迹</button>
            </td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="columns.length + 1" class="empty-state">暂无符合条件的无人机巡查任务</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ rows.length }} 条无人机巡查任务</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </template>

    <!-- 核查提醒 -->
    <template v-else>
      <p class="status-legend">
        <span class="legend-item">仅展示未处理待办；每条异常只生成一条，空航迹不产生待办</span>
      </p>
      <table class="data-table">
        <thead>
          <tr>
            <th>任务编号</th>
            <th>飞行区域</th>
            <th>飞手</th>
            <th>任务当前状态</th>
            <th>待办事项</th>
            <th>位置说明</th>
            <th>生成时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in reminders" :key="item.id">
            <td>{{ item.taskCode }}</td>
            <td>{{ item.areaLabel }}</td>
            <td>{{ item.pilotName }}</td>
            <td>{{ item.taskStatus }}</td>
            <td>{{ item.title }}</td>
            <td>{{ item.detail }}</td>
            <td>{{ item.createdAt }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="goReminderTrack(item.sortieId)">核对航迹</button>
              <button class="link" type="button" @click="handleResolve(item.id)">标记已处理</button>
            </td>
          </tr>
          <tr v-if="!reminders.length">
            <td colspan="8" class="empty-state">没有待核查的提醒</td>
          </tr>
        </tbody>
      </table>
      <footer class="page-foot">
        <span>共 {{ reminders.length }} 条待核查提醒</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { downloadEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  droneStats,
  listReminders,
  listSortiesOfTask,
  listTasks,
  resolveReminder,
  type TaskView,
} from '@/api/drone-service'

const router = useRouter()
const meta = moduleMeta('drone')
const columns = ['任务编号', '飞行区域', '飞行路线', '飞手姓名', '起飞时间', '降落时间', '发现异常数', '任务状态']
const filterFields = ['任务编号', '飞行区域', '飞手姓名', '任务状态']
const statuses = ['待执行', '飞行中', '已完成', '因故中止']

const activeTab = ref<'tasks' | 'reminders'>('tasks')
const rows = ref<TaskView[]>([])
const reminders = ref<ReturnType<typeof listReminders>>([])
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

const statCards = computed(() => {
  const stats = droneStats()
  return [
    { label: '今日上传架次', value: stats.todaySorties },
    { label: '已完成任务', value: stats.completedTasks },
    { label: '发现异常数（已回写）', value: stats.anomalyCount },
    { label: '待核查提醒', value: stats.pendingReminders },
  ]
})

const tabs = computed(() => [
  { key: 'tasks' as const, label: '任务列表', badge: 0 },
  { key: 'reminders' as const, label: '核查提醒', badge: droneStats().pendingReminders },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

function display(row: TaskView, column: string): string | number {
  if (column === '飞行区域') {
    return row.areaLabel
  }
  if (column === '起飞时间' || column === '降落时间') {
    return row[column === '起飞时间' ? 'takeoffAt' : 'landingAt'] || '—'
  }
  const map: Record<string, keyof TaskView> = {
    任务编号: 'code',
    飞行路线: 'route',
    飞手姓名: 'pilotName',
    发现异常数: 'anomalyCount',
    任务状态: 'status',
  }
  const key = map[column]
  return key ? (row[key] as string | number) : '—'
}

function switchTab(tab: 'tasks' | 'reminders') {
  activeTab.value = tab
  errorMessage.value = ''
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: TaskView) {
  errorMessage.value = ''
  const result = applyAction(meta.key, row.id, action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function goUpload(taskId: number) {
  router.push({ name: 'drone-upload', params: { taskId: String(taskId) } })
}

function goTrack(taskId: number) {
  const sorties = listSortiesOfTask(taskId)
  if (!sorties.length) {
    errorMessage.value = '该任务还没有任何架次记录，空航迹不会生成待办'
    return
  }
  router.push({ name: 'drone-track', params: { sortieId: sorties[sorties.length - 1].id } })
}

function goReminderTrack(sortieId: string) {
  router.push({ name: 'drone-track', params: { sortieId } })
}

function handleResolve(reminderId: string) {
  const result = resolveReminder(reminderId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  if (activeTab.value === 'tasks') {
    rows.value = listTasks(filters.value)
  } else {
    reminders.value = listReminders(false)
  }
}

onMounted(reload)
</script>

<style scoped>
.tab-bar { display: flex; gap: 8px; margin-bottom: 12px; }
.tab-btn {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px 6px 0 0;
  padding: 6px 16px;
  cursor: pointer;
  font-size: 13px;
}
.tab-btn.active { background: var(--brand); border-color: var(--brand); color: #fff; }
.tab-badge {
  display: inline-block;
  min-width: 18px;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 999px;
  background: #b42318;
  color: #fff;
  font-size: 11px;
  line-height: 16px;
}
.tab-btn.active .tab-badge { background: #fff; color: #b42318; }
</style>
