<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>航迹详情</h2>
        <p class="page-desc">航段上传进度、异常上报与异常报告都在同一页；异常报告只能提交，不能撤回。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="backToList">返回任务列表</button>
      </div>
    </header>

    <template v-if="detail">
      <article class="detail-card">
        <h3 class="detail-title">{{ detail.task.code }} · 第 {{ detail.sortie.sortieNo }} 架次</h3>
        <div class="detail-grid">
          <p><span>飞行区域</span>{{ detail.sortie.area }}</p>
          <p><span>飞行路线</span>{{ detail.sortie.route }}</p>
          <p><span>飞手</span>{{ detail.sortie.pilotName }}</p>
          <p><span>任务当前状态</span>{{ detail.task.status }}</p>
          <p><span>原始起飞时间</span>{{ detail.sortie.takeoffAt || '—' }}</p>
          <p><span>原始降落时间</span>{{ detail.sortie.landingAt || '—' }}</p>
          <p><span>架次上传状态</span>
            <strong :class="statusClass(detail.sortie.status)">{{ detail.sortie.status }}</strong>
          </p>
          <p v-if="detail.sortie.status === '上传失败'">
            <span>续传起点</span>第 {{ (detail.sortie.failAtSegment ?? 0) + 1 }} 航段起
          </p>
        </div>
        <div class="detail-actions">
          <button
            v-if="detail.uploaded && anomalyItems.length > 0"
            class="btn primary"
            type="button"
            :disabled="allReportsSubmitted"
            @click="submitReports"
          >
            {{ allReportsSubmitted ? '异常已提交（不可重复）' : `提交 ${anomalyItems.length - detail.reports.length} 条异常报告` }}
          </button>
          <button
            v-if="detail.sortie.status !== '已上传'"
            class="btn"
            type="button"
            @click="resume"
          >
            从缺失航段续传
          </button>
        </div>
      </article>

      <h3 class="block-title">航段（{{ uploadedCount }}/{{ detail.segments.length }} 已上传）</h3>
      <table class="data-table">
        <thead>
          <tr><th>序号</th><th>航段名称</th><th>航点</th><th>上传状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="seg in detail.segments" :key="seg.index">
            <td>{{ seg.index + 1 }}</td>
            <td>{{ seg.name }}</td>
            <td>{{ seg.point }}</td>
            <td :class="seg.uploaded ? 'ok-text' : 'error-text'">{{ seg.uploaded ? '已上传' : '缺失（待续传）' }}</td>
          </tr>
          <tr v-if="!detail.segments.length">
            <td colspan="4" class="empty-state">没有航段（空航迹不会生成任何待办）</td>
          </tr>
        </tbody>
      </table>

      <h3 class="block-title">飞手上报异常（{{ anomalyItems.length }} 条）</h3>
      <table class="data-table">
        <thead>
          <tr><th>序号</th><th>异常描述</th><th>位置</th><th>报告状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="anomaly in anomalyItems" :key="anomaly.no">
            <td>{{ anomaly.no }}</td>
            <td>{{ anomaly.description }}</td>
            <td>{{ anomaly.location }}</td>
            <td>
              <span v-if="reportOf(anomaly.no)" class="ok-text">
                已单向提交 · {{ reportOf(anomaly.no)?.reportedAt }}
              </span>
              <span v-else class="error-text">待提交</span>
            </td>
          </tr>
          <tr v-if="!anomalyItems.length">
            <td colspan="4" class="empty-state">本架次未发现异常</td>
          </tr>
        </tbody>
      </table>
    </template>

    <template v-else>
      <p class="empty-state">找不到该航迹记录。</p>
    </template>

    <footer class="page-foot">
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  getTrackDetail,
  submitAnomalyReports,
  type TrackDetail,
} from '@/api/drone-service'

const route = useRoute()
const router = useRouter()

const detail = ref<TrackDetail | null>(null)
const message = ref('')
const messageOk = ref(false)

const anomalyItems = computed(() => detail.value?.anomalies ?? [])
const uploadedCount = computed(() => detail.value?.segments.filter((s) => s.uploaded).length ?? 0)
const allReportsSubmitted = computed(
  () => !!detail.value && detail.value.anomalies.length > 0 && detail.value.reports.length >= detail.value.anomalies.length,
)

function reportOf(no: number) {
  return detail.value?.reports.find((r) => r.anomalyNo === no)
}

function statusClass(status: string): string {
  if (status === '已上传') {
    return 'ok-text'
  }
  if (status === '上传失败') {
    return 'error-text'
  }
  return ''
}

function load() {
  message.value = ''
  const sortieId = String(route.params.sortieId ?? '')
  detail.value = getTrackDetail(sortieId)
}

// 同一组件内切换不同架次（如从提醒跳到另一航迹）时重新读取。
watch(() => route.params.sortieId, load, { immediate: true })

function submitReports() {
  if (!detail.value) {
    return
  }
  const result = submitAnomalyReports(detail.value.sortie.id)
  message.value = result.message
  messageOk.value = result.ok
  load()
}

function resume() {
  if (!detail.value) {
    return
  }
  router.push({ name: 'drone-upload', params: { taskId: String(detail.value.task.id) }, query: { sortie: String(detail.value.sortie.sortieNo) } })
}

function backToList() {
  router.push({ name: 'drone' })
}
</script>

<style scoped>
.detail-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
.detail-title { margin: 0 0 10px; font-size: 15px; }
.detail-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px 16px; margin: 0; }
.detail-grid p { margin: 0; font-size: 13px; }
.detail-grid span { display: block; color: var(--muted); font-size: 12px; }
.detail-actions { margin-top: 12px; display: flex; gap: 8px; }
.block-title { font-size: 14px; margin: 18px 0 8px; }
.ok-text { color: #067647; }
.btn:disabled { opacity: .7; cursor: not-allowed; }
</style>
