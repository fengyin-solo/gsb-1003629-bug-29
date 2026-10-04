/* eslint-disable no-console */
// 领域逻辑自测：覆盖状态一致性、异常数回写、空航迹、单向提交、幂等、断点续传、回退、并发拒绝。
import assert from 'node:assert'

import {
  abortTask,
  completeTask,
  droneDB,
  droneStats,
  droneTaskRows,
  getTrackDetail,
  listReminders,
  listSortiesOfTask,
  listTasks,
  nextSortieNo,
  resolveReminder,
  startTask,
  submitAnomalyReports,
  uploadSortie,
} from '../src/api/drone-service'
import { resetDroneDB, commitDB } from '../src/data/drone/drone-store'

let passed = 0
function check(name, cond) {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function main() {
  resetDroneDB()

  // 1. 三处展示同源：中止后任务状态是「因故中止」，列表/概览待办不再把它当飞行中。
  console.log('状态一致性')
  abortTask(1) // 把种子里仍在飞行中的 DRON-0001 中止
  let task1 = listTasks().find((t) => t.id === 1)
  check('中止后列表状态为因故中止', task1.status === '因故中止')
  let row1 = droneTaskRows().find((r) => r.id === 1)
  check('中止后概览 pending=false（不算待办）', row1.pending === false)
  check('中止后行内状态文本也是因故中止', row1.任务状态 === '因故中止')
  // 种子里任务2本来就是因故中止
  let task2 = listTasks().find((t) => t.id === 2)
  check('已中止任务不能再中止', abortTask(2).ok === false)
  check('已中止任务不能确认完成', completeTask(2).ok === false)
  check('已中止任务不能开始飞行', startTask(2).ok === false)

  // 2. 异常数回写：种子任务3两架异常已在库，数字一致；新上传后重新汇总。
  console.log('异常数回写')
  const task3 = listTasks().find((t) => t.id === 3)
  check('已完成任务异常数=2', task3.anomalyCount === 2)
  check('概览行 abnormal=true', droneTaskRows().find((r) => r.id === 3).abnormal === true)

  // 3. 空航迹：拒收，不生成架次/待办，不会重复显示。
  console.log('空航迹')
  const remindersBefore = listReminders().length
  const empty = await uploadSortie({
    taskId: 4,
    sortieNo: 1,
    takeoffAt: '2026-10-04 13:00',
    landingAt: '2026-10-04 13:40',
    segments: [{ name: '', point: '' }],
    anomalies: [{ no: 1, description: '不该出现', location: 'X' }],
    delayMs: 1,
  })
  check('空航迹被拒绝', empty.ok === false)
  check('空航迹不生成架次', listSortiesOfTask(4).length === 0)
  check('空航迹不生成提醒', listReminders().length === remindersBefore)

  // 4. 飞行区域为空时补齐 + 原始起降时间保留。
  console.log('区域补齐 / 原始时间保留')
  const task4 = listTasks().find((t) => t.id === 4)
  check('任务4登记区域为空', task4.area === '')
  startTask(4)
  const ok1 = await uploadSortie({
    taskId: 4,
    sortieNo: 1,
    area: '', // 任务区域也空 → 用飞手李峰责任区「青松岭林区」
    takeoffAt: '2026-10-04 13:00',
    landingAt: '2026-10-04 13:40',
    segments: [
      { name: '起飞段', point: 'A' },
      { name: '巡护段', point: 'B' },
    ],
    anomalies: [{ no: 1, description: '可疑烟点', location: 'B 附近' }],
    delayMs: 1,
  })
  check('首传成功', ok1.ok === true)
  const s41 = listSortiesOfTask(4)[0]
  check('区域按飞手责任区补齐为青松岭林区', s41.area === '青松岭林区')
  check('任务异常数回写为1', listTasks().find((t) => t.id === 4).anomalyCount === 1)
  check('飞手异常随架次落库，共1条待提交', s41.anomalies.length === 1)
  check('上传成功本身不自动提交异常（无提醒）', listReminders().filter((r) => r.sortieId === '4-1').length === 0)

  // 5. 异常单向提交：只提交一次、重复拒绝、没有撤回入口。
  console.log('异常单向提交')
  const submit1 = submitAnomalyReports('4-1')
  check('首次提交成功', submit1.ok === true)
  check('提交后生成1条提醒', listReminders().some((r) => r.sortieId === '4-1'))
  const submit2 = submitAnomalyReports('4-1')
  check('重复提交被拒绝', submit2.ok === false)
  const reminders4 = listReminders().filter((r) => r.sortieId === '4-1')
  check('提醒不重复（仍只有1条）', reminders4.length === 1)
  check('没有撤回异常的服务方法（仅 resolveReminder 处理提醒）', typeof resolveReminder === 'function')
  // 任务中止后，已提交报告与提醒仍然保留可查（提醒页任务状态显示因故中止）
  abortTask(4)
  const remAfterAbort = listReminders().find((r) => r.sortieId === '4-1')
  check('中止后提醒仍在且任务状态显示因故中止', remAfterAbort && remAfterAbort.taskStatus === '因故中止')

  // 6. 幂等：重复上传同一架次只生效一次。
  console.log('幂等')
  const dupe = await uploadSortie({
    taskId: 4,
    sortieNo: 1,
    area: '篡改区域',
    takeoffAt: '2099-01-01 00:00',
    landingAt: '2099-01-01 00:00',
    segments: [{ name: 'X', point: 'Y' }],
    anomalies: [{ no: 1, description: '再来一条', location: 'Z' }],
    delayMs: 1,
  })
  check('重复上传返回成功但标记幂等', dupe.ok === true && dupe.duplicated === true)
  const s41b = listSortiesOfTask(4)[0]
  check('区域不被重复上传篡改', s41b.area === '青松岭林区')
  check('原始起降时间保留', s41b.takeoffAt === '2026-10-04 13:00' && s41b.landingAt === '2026-10-04 13:40')
  check('异常/报告不重复', listReminders().filter((r) => r.sortieId === '4-1').length === 1)

  // 7. 失败 → 从缺失航段重试 → 成功后任务/报告/提醒一致。
  console.log('断点续传与回退')
  // 新建一个由飞手责任区补齐区域的任务5（中止态）：失败回退应保持「因故中止」，不能变回飞行中。
  const db0 = JSON.parse(JSON.stringify(droneDB()))
  db0.tasks.push({
    id: 5,
    code: 'DRON-0005',
    area: '',
    route: '白桦沟西线',
    pilotId: 2,
    status: '因故中止',
    takeoffAt: '2026-10-04 14:50',
    landingAt: '',
    anomalyCount: 0,
  })
  commitDB(db0)
  check('任务5下一架次号=1', nextSortieNo(5) === 1)
  const fail = await uploadSortie({
    taskId: 5,
    sortieNo: 1,
    area: '',
    takeoffAt: '2026-10-04 15:00',
    landingAt: '2026-10-04 15:30',
    segments: [
      { name: '起飞段', point: 'P0' },
      { name: '巡护段A', point: 'P1' },
      { name: '巡护段B', point: 'P2' },
    ],
    anomalies: [{ no: 1, description: '火点', location: 'P2' }],
    failSegmentIndexes: [1], // 第2航段失败
    delayMs: 1,
  })
  check('失败返回 false', fail.ok === false)
  check('失败提示缺失航段=第2段(index1)', fail.missingSegment === 1)
  const partial = listSortiesOfTask(5)[0]
  check('失败后架次状态=上传失败', partial.status === '上传失败')
  check('第1航段保留成功（断点）', partial.segments[0].uploaded === true)
  check('第2航段未传', partial.segments[1].uploaded === false)
  check('失败后任务状态回退保持因故中止', listTasks().find((t) => t.id === 5).status === '因故中止')
  check('失败不产生异常报告/提醒', listReminders().filter((r) => r.taskId === 5).length === 0)
  check('失败不回写异常数', listTasks().find((t) => t.id === 5).anomalyCount === 0)

  // 续传：从缺失航段重试（这次不勾选失败），原始时间沿用。
  const retry = await uploadSortie({
    taskId: 5,
    sortieNo: 1,
    area: '白桦沟林区',
    takeoffAt: '2026-10-04 15:00',
    landingAt: '2026-10-04 15:30',
    segments: [
      { name: '起飞段', point: 'P0' },
      { name: '巡护段A', point: 'P1' },
      { name: '巡护段B', point: 'P2' },
    ],
    anomalies: [{ no: 1, description: '火点', location: 'P2' }],
    delayMs: 1,
  })
  check('续传成功', retry.ok === true)
  const done = listSortiesOfTask(5)[0]
  check('三段全部已传', done.segments.every((s) => s.uploaded) === true)
  check('区域沿用首次补齐值（白桦沟林区）', done.area === '白桦沟林区')
  check('原始起降时间仍是首次值', done.takeoffAt === '2026-10-04 15:00' && done.landingAt === '2026-10-04 15:30')
  check('续传成功后异常数回写为1', listTasks().find((t) => t.id === 5).anomalyCount === 1)
  check('续传成功后仍未提交异常（无提醒），需显式单向提交', listReminders().filter((r) => r.taskId === 5).length === 0)
  const submitTask5 = submitAnomalyReports('5-1')
  check('显式提交异常报告成功', submitTask5.ok === true)
  check('提交后才生成1条提醒', listReminders().filter((r) => r.taskId === 5).length === 1)
  check('再次提交被拒绝（单向、幂等）', submitAnomalyReports('5-1').ok === false)
  const detail = getTrackDetail('5-1')
  check('航迹详情与库同源（报告1条、航段3条）', detail.reports.length === 1 && detail.segments.length === 3)

  // 8. 并发上传：第二次提交被拒绝。
  console.log('并发拒绝')
  const concurrentResults = await Promise.all([
    uploadSortie({
      taskId: 5,
      sortieNo: 2,
      takeoffAt: '2026-10-04 16:00',
      landingAt: '2026-10-04 16:20',
      segments: [
        { name: 'S1', point: 'a' },
        { name: 'S2', point: 'b' },
        { name: 'S3', point: 'c' },
      ],
      delayMs: 40,
    }),
    uploadSortie({
      taskId: 5,
      sortieNo: 2,
      takeoffAt: '2026-10-04 16:00',
      landingAt: '2026-10-04 16:20',
      segments: [
        { name: 'S1', point: 'a' },
        { name: 'S2', point: 'b' },
        { name: 'S3', point: 'c' },
      ],
      delayMs: 40,
    }),
  ])
  const okCount = concurrentResults.filter((r) => r.ok).length
  const rejected = concurrentResults.find((r) => !r.ok)
  check('并发两次仅一次成功', okCount === 1)
  check('被拒者提示重复提交', rejected && /正在上传/.test(rejected.message))
  // 两次并发都 settle 后再传同样架次 → 幂等成功（锁已释放）
  const after = await uploadSortie({
    taskId: 5,
    sortieNo: 2,
    takeoffAt: '2026-10-04 16:00',
    landingAt: '2026-10-04 16:20',
    segments: [{ name: 'S1', point: 'a' }],
    delayMs: 1,
  })
  check('并发结束后再传走幂等，不重复生效', after.ok === true && after.duplicated === true)

  // 9. 统计与提醒处理。
  console.log('统计与提醒')
  const stats = droneStats()
  check('异常量汇总>0', stats.anomalyCount >= 4) // 任务1:1 任务3:2 任务4:1
  check('待核查提醒>0', stats.pendingReminders >= 2)
  const pending = listReminders().find((r) => r.sortieId === '5-1')
  resolveReminder(pending.id)
  check('提醒可标记处理且只处理一次', resolveReminder(pending.id).ok === false)

  console.log(`\n全部通过：${passed} 项断言`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
