<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>架次航迹上传</h2>
        <p class="page-desc">同一架次重复提交只生效一次；失败后已传航段保留，可从第一个缺失航段续传；并发提交会被拒绝。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="backToList">返回任务列表</button>
      </div>
    </header>

    <article v-if="task" class="detail-card">
      <div class="detail-grid">
        <p><span>任务编号</span>{{ task.code }}</p>
        <p><span>飞手</span>{{ task.pilotName }}</p>
        <p><span>飞行路线</span>{{ task.route }}</p>
        <p><span>任务当前状态</span>{{ task.status }}</p>
        <p><span>任务登记飞行区域</span>{{ task.area || '（空，上传时补齐）' }}</p>
        <p v-if="areaPreview" class="hint"><span>本次实际使用飞行区域</span>{{ areaPreview }}</p>
      </div>
    </article>

    <template v-if="existingSortie">
      <p v-if="existingSortie.status === '已上传'" class="done-banner">
        该架次已上传成功（{{ existingSortie.uploadedAt }}）。重复上传不会再生效，也不会重复生成提醒。
      </p>
      <p v-else class="warn-banner">
        这是第 {{ existingSortie.sortieNo }} 架次的续传：原始起降时间沿用首次记录，
        已上传 {{ uploadedOfExisting }}/{{ existingSortie.segments.length }} 个航段，将从第一个缺失航段继续。
      </p>
    </template>

    <form class="upload-form" @submit.prevent="submit">
      <div class="form-row">
        <label class="form-item">
          <span>架次号</span>
          <input v-model.number="sortieNo" type="number" min="1" required />
        </label>
        <label class="form-item">
          <span>原始起飞时间</span>
          <input v-model="takeoffAt" type="datetime-local" required />
        </label>
        <label class="form-item">
          <span>原始降落时间</span>
          <input v-model="landingAt" type="datetime-local" required />
        </label>
      </div>
      <label class="form-item wide">
        <span>飞行区域（留空时按 任务区域 → 飞手责任区「{{ pilotArea }}」→ 未登记飞行区域 补齐）</span>
        <input v-model="area" :placeholder="areaPlaceholder" />
      </label>

      <h3 class="block-title">航段（至少 1 个；空航迹会被拒绝，不生成待办）</h3>
      <div v-for="(seg, index) in segments" :key="index" class="segment-row">
        <input v-model="seg.name" :placeholder="`航段 ${index + 1} 名称`" required />
        <input v-model="seg.point" placeholder="航点描述" />
        <label class="fail-check" v-if="!existingSortie || !(existingSeg(index)?.uploaded)">
          <input v-model="failIndexes" type="checkbox" :value="index" /> 模拟此航段失败
        </label>
        <span v-else class="seg-done">已上传，续传跳过</span>
        <button class="btn ghost" type="button" @click="removeSegment(index)">删除</button>
      </div>
      <button class="btn" type="button" @click="addSegment">添加航段</button>

      <h3 class="block-title">飞手上报异常（随架次提交；成功后在航迹页单向提交报告）</h3>
      <div v-for="(anomaly, index) in anomalies" :key="index" class="segment-row">
        <input v-model="anomaly.description" :placeholder="`异常 ${index + 1} 描述`" />
        <input v-model="anomaly.location" placeholder="异常位置" />
        <button class="btn ghost" type="button" @click="removeAnomaly(index)">删除</button>
      </div>
      <button class="btn" type="button" @click="addAnomaly">添加异常</button>

      <div class="submit-row">
        <button class="btn primary" type="submit" :disabled="uploading">
          {{ uploading ? `上传中 ${progressText}` : existingSortie?.status === '已上传' ? '重复上传（幂等校验）' : '提交上传' }}
        </button>
        <span v-if="uploading" class="hint">正在逐航段上传，重复点击会被拒绝</span>
      </div>
    </form>

    <footer class="page-foot">
      <span v-if="message" :class="outcomeOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  FALLBACK_AREA,
  droneDB as readDroneDB,
  listSortiesOfTask,
  nextSortieNo,
  resolvePilot,
  uploadSortie,
  type TaskView,
} from '@/api/drone-service'
import type { Sortie } from '@/data/drone/types'

const route = useRoute()
const router = useRouter()
const taskId = Number(route.params.taskId)

function toInput(value: string): string {
  // datetime-local 的 "YYYY-MM-DDTHH:mm" 转成库内统一的 "YYYY-MM-DD HH:mm"。
  return value ? value.replace('T', ' ') : ''
}

const task = ref<TaskView | null>(null)
const sortieNo = ref(1)
const takeoffAt = ref('')
const landingAt = ref('')
const area = ref('')
const segments = ref<{ name: string; point: string }[]>([{ name: '', point: '' }])
const anomalies = ref<{ description: string; location: string }[]>([])
const failIndexes = ref<number[]>([])

const uploading = ref(false)
const message = ref('')
const outcomeOk = ref(false)
const progressText = ref('')
const existingSortie = ref<Sortie | null>(null)

const pilotArea = computed(() => {
  if (!task.value) {
    return ''
  }
  const raw = readDroneDB().pilots.find((p) => p.name === task.value!.pilotName)
  return raw ? raw.defaultArea : ''
})

const areaPlaceholder = computed(() => {
  if (task.value?.area) {
    return `留空则用任务登记区域：${task.value.area}`
  }
  if (pilotArea.value) {
    return `留空则用飞手责任区：${pilotArea.value}`
  }
  return `留空则记为「${FALLBACK_AREA}」`
})

const areaPreview = computed(() => {
  if (!task.value) {
    return ''
  }
  const declared = area.value.trim()
  if (declared) {
    return declared
  }
  if (task.value.area.trim()) {
    return task.value.area
  }
  return pilotArea.value || FALLBACK_AREA
})

const uploadedOfExisting = computed(
  () => existingSortie.value?.segments.filter((s) => s.uploaded).length ?? 0,
)

function existingSeg(index: number) {
  return existingSortie.value?.segments.find((s) => s.index === index)
}

function addSegment() {
  segments.value.push({ name: '', point: '' })
}

function removeSegment(index: number) {
  segments.value.splice(index, 1)
  failIndexes.value = failIndexes.value.filter((i) => i !== index)
}

function addAnomaly() {
  anomalies.value.push({ description: '', location: '' })
}

function removeAnomaly(index: number) {
  anomalies.value.splice(index, 1)
}

function init() {
  const db = readDroneDB()
  const rawTask = db.tasks.find((t) => t.id === taskId)
  if (!rawTask) {
    message.value = '没有找到该任务，请返回列表重新进入'
    return
  }
  const pilot = resolvePilot(db, rawTask.pilotId)
  task.value = {
    ...rawTask,
    pilotName: pilot ? pilot.name : `飞手#${rawTask.pilotId}`,
    areaLabel: rawTask.area || '未登记（上传时按飞手责任区补齐）',
  }

  // 路由带 sortie=架次号 表示从航迹页/失败入口进来续传；否则定位该任务最近一个未完成架次。
  const list = listSortiesOfTask(taskId)
  const queryNo = route.query.sortie ? Number(route.query.sortie) : NaN
  const target =
    list.find((s) => s.sortieNo === queryNo) ??
    list.filter((s) => s.status !== '已上传').sort((a, b) => b.sortieNo - a.sortieNo)[0] ??
    null
  existingSortie.value = target
  if (target) {
    sortieNo.value = target.sortieNo
    takeoffAt.value = toInputValue(target.takeoffAt)
    landingAt.value = toInputValue(target.landingAt)
    area.value = ''
    segments.value = target.segments.map((s) => ({ name: s.name, point: s.point }))
    anomalies.value = target.anomalies.map((a) => ({ description: a.description, location: a.location }))
    // 失败模拟勾选默认清空，保证正常续传能成功；需要复现失败可再手动勾选缺失航段。
    failIndexes.value = []
  } else {
    sortieNo.value = nextSortieNo(taskId)
    takeoffAt.value = toInputValue(rawTask.takeoffAt)
    landingAt.value = toInputValue(rawTask.landingAt)
  }
}

function toInputValue(value: string): string {
  // "YYYY-MM-DD HH:mm" → datetime-local 需要的 "YYYY-MM-DDTHH:mm"。
  return value ? value.replace(' ', 'T') : ''
}

async function submit() {
  if (uploading.value) {
    message.value = '同一架次正在上传，第二次提交已拒绝'
    outcomeOk.value = false
    return
  }
  if (!task.value) {
    message.value = '任务不存在，无法上传'
    outcomeOk.value = false
    return
  }
  uploading.value = true
  outcomeOk.value = false
  progressText.value = ''
  try {
    const result = await uploadSortie({
      taskId,
      sortieNo: sortieNo.value,
      area: area.value,
      takeoffAt: toInput(takeoffAt.value),
      landingAt: toInput(landingAt.value),
      segments: segments.value.map((seg) => ({ name: seg.name.trim(), point: seg.point.trim() })),
      anomalies: anomalies.value
        .filter((a) => a.description.trim())
        .map((a, index) => ({ no: index + 1, description: a.description.trim(), location: a.location.trim() })),
      failSegmentIndexes: failIndexes.value,
      onProgress: (p) => {
        progressText.value = `${p.segmentIndex + 1}/${p.total}`
      },
    })
    message.value = result.message
    outcomeOk.value = result.ok
    // 成功（含幂等命中）：返回任务列表再次核对；失败也回列表，从列表重新进入可从缺失航段续传。
    if (result.ok) {
      setTimeout(() => backToList(), 600)
    } else {
      setTimeout(() => backToList(), 1200)
    }
  } finally {
    uploading.value = false
  }
}

function backToList() {
  router.push({ name: 'drone' })
}

init()
</script>

<style scoped>
.detail-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 14px; }
.detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 16px; }
.detail-grid p { margin: 0; font-size: 13px; }
.detail-grid span { display: block; color: var(--muted); font-size: 12px; }
.hint { color: var(--muted); }
.done-banner { background: #ecfdf3; border: 1px solid #abefc6; color: #067647; border-radius: 6px; padding: 8px 12px; font-size: 13px; }
.warn-banner { background: #fffaeb; border: 1px solid #fedf89; color: #b54708; border-radius: 6px; padding: 8px 12px; font-size: 13px; }
.upload-form { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.form-row { display: flex; gap: 12px; flex-wrap: wrap; }
.form-item { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); margin-bottom: 10px; }
.form-item.wide { max-width: 560px; }
.form-item input, .segment-row input { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; }
.block-title { font-size: 14px; margin: 14px 0 8px; }
.segment-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.segment-row input:first-child { width: 180px; }
.segment-row input:nth-child(2) { flex: 1; min-width: 200px; }
.fail-check { color: #b54708; font-size: 12px; display: flex; align-items: center; gap: 4px; }
.seg-done { color: #067647; font-size: 12px; }
.submit-row { margin-top: 16px; display: flex; align-items: center; gap: 12px; }
.ok-text { color: #067647; }
</style>
