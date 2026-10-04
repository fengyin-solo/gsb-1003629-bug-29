/* eslint-disable no-console */
// 无人机域端到端校验：stub localStorage 后直接驱动 drone-service，验证所有修复点。
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---- stub browser 环境 ----
const mem = new Map()
const storage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
}
globalThis.window = { localStorage: storage }

const dir = mkdtempSync(join(tmpdir(), 'drone-test-'))
const entry = join(dir, 'entry.ts')
writeFileSync(
  entry,
  `
  export * from '/workspace/frontend/src/api/drone-service.ts'
  export { listRows, saveRows } from '/workspace/frontend/src/data/local-store.ts'
  export { droneDomain } from '/workspace/frontend/src/data/drone-store.ts'
  `,
)
const outfile = join(dir, 'bundle.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
  alias: { '@': '/workspace/frontend/src' },
})
const svc = await import(pathToFileURL(outfile).href)

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log('  ✓', name)
  } else {
    fail += 1
    console.log('  ✗', name, detail)
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function seg(seq, extra = {}) {
  return {
    seq,
    起飞时间: `2026-10-04 ${10 + seq}:00`,
    降落时间: `2026-10-04 ${10 + seq}:20`,
    飞行区域: '',
    航点: `WP-${seq}`,
    异常数: 0,
    ...extra,
  }
}

// ============ 1. 种子一致性：中止后状态、异常数、提醒 ============
console.log('1) 种子一致性')
const d0 = svc.listTasks()
const t4 = d0.find((r) => r['任务编号'] === 'DRON-0004')
check('DRON-0004 列表状态为「因故中止」（不是飞行中）', t4.status === '因故中止', t4.status)
check('DRON-0004 异常数已回写为 1', Number(t4['发现异常数']) === 1, t4['发现异常数'])
const t2 = d0.find((r) => r['任务编号'] === 'DRON-0002')
check('DRON-0002 飞行中且异常数为 1', t2.status === '飞行中' && Number(t2['发现异常数']) === 1)
const seedReminders = svc.listReminders()
check('种子只有 2 条提醒（无空航迹重复待办）', seedReminders.length === 2, seedReminders.length)
const seedReports = svc.listRows('firereport')
check('火情报告含 2 条联动报告', seedReports.filter((r) => String(r['报告编号']).startsWith('FIRE-DRON')).length === 2)

// ============ 2. 终态按钮守卫 ============
console.log('2) 状态流转单向守卫')
const abortDone = svc.transitionTask(t4.id, '中止任务')
check('已中止任务不能再次中止', abortDone.ok === false)
const abortStart = svc.transitionTask(t4.id, '开始飞行')
check('已中止任务不能开始飞行（不复活）', abortStart.ok === false)
const t3 = d0.find((r) => r['任务编号'] === 'DRON-0003')
check('已完成任务不能中止', svc.transitionTask(t3.id, '中止任务').ok === false)
check('飞行中任务不能直接「开始飞行」', svc.transitionTask(t2.id, '开始飞行').ok === false)
check('有缺失航段的飞行中任务不能确认完成', svc.transitionTask(t2.id, '确认完成').ok === false)

// ============ 3. 空航迹拒绝 ============
console.log('3) 空航迹拒绝')
const emptyRes = await svc.uploadTrack({
  任务编号: 'DRON-0001',
  架次编号: 'SORT-EMPTY',
  飞手姓名: '李远航',
  总段数: 2,
  完成声明: true,
  航段: [],
  强制失败: false,
})
check('空航迹被拒绝', emptyRes.ok === false, emptyRes.message)
check('空航迹不生成提醒', svc.listReminders().length === 2)
check('空航迹不生成报告', svc.listRows('firereport').length === seedReports.length)
check('空航迹不生成架次', svc.listSorties('DRON-0001').length === 0)

// ============ 4. 未在册/停飞飞手拒绝 ============
console.log('4) 飞手校验')
const badPilot = await svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-X1', 飞手姓名: '不存在',
  总段数: 1, 完成声明: true, 航段: [seg(1)], 强制失败: false,
})
check('未登记飞手被拒绝', badPilot.ok === false)
const groundedPilot = await svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-X2', 飞手姓名: '赵雁回',
  总段数: 1, 完成声明: true, 航段: [seg(1)], 强制失败: false,
})
check('停飞飞手被拒绝', groundedPilot.ok === false)

// ============ 5. 正常上传：区域补齐 + 原始起降时间保留 ============
console.log('5) 正常上传与补齐/保留规则')
const up1 = await svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-1001', 飞手姓名: '李远航',
  总段数: 2, 完成声明: false,
  航段: [seg(1, { 飞行区域: '南坡幼林带', 异常数: 1 })],
  强制失败: false,
})
check('首批部分上传成功', up1.ok === true, up1.message)
check('任务转为飞行中', up1.任务状态 === '飞行中', up1.任务状态)
check('任务起飞时间沿用航段原始时间（任务原本为空）',
  svc.listTasks().find((r) => r['任务编号'] === 'DRON-0001')['起飞时间'] === seg(1).起飞时间)

// 传第二批（齐），区域留空 → 沿用任务区域补齐；降落时间回写
const up2 = await svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-1001', 飞手姓名: '李远航',
  总段数: 2, 完成声明: true,
  航段: [seg(2, { 异常数: 2 })],
  强制失败: false,
})
check('次批补齐后任务完成', up2.ok === true && up2.任务状态 === '已完成', up2.message)
const s1001 = svc.getSortie('SORT-1001')
check('第 2 段空区域被沿用任务区域补齐',
  s1001.航段.find((s) => s.seq === 2).飞行区域.includes('南坡幼林带'),
  JSON.stringify(s1001.航段.find((s) => s.seq === 2).飞行区域))
const t1Done = svc.listTasks().find((r) => r['任务编号'] === 'DRON-0001')
check('异常数单向累加为 3', up2.异常数 === 3 && Number(t1Done['发现异常数']) === 3, String(up2.异常数))
check('任务降落时间已回写', Boolean(t1Done['降落时间']))
check('异常生成 1 份报告 + 1 条提醒',
  Boolean(up2.生成报告) && Boolean(up2.生成提醒), `${up2.生成报告} ${up2.生成提醒}`)

// 原始起降时间保留：重传同样段，带不同时间 → 不覆盖
const upRe = await svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-1001', 飞手姓名: '李远航',
  总段数: 2, 完成声明: true,
  航段: [seg(1, { 起飞时间: '2099-01-01 00:00', 降落时间: '2099-01-01 00:20', 飞行区域: '南坡幼林带' })],
  强制失败: false,
})
const s1001b = svc.getSortie('SORT-1001')
check('原始起飞时间不被重传覆盖', s1001b.原始起飞时间 === seg(1).起飞时间, s1001b.原始起飞时间)
check('重传段不重复计数（异常仍为 3）', s1001b.异常数 === 3, String(s1001b.异常数))

// ============ 6. 完整架次重复上传：整体只生效一次 ============
console.log('6) 同一架次重复上传')
const dup = await svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-1001', 飞手姓名: '李远航',
  总段数: 2, 完成声明: true,
  航段: [seg(1, { 飞行区域: '南坡幼林带' }), seg(2)],
  强制失败: false,
})
check('完整架次重复上传被拒绝', dup.ok === false, dup.message)
check('报告未重复生成',
  svc.listRows('firereport').filter((r) => r['报告编号'] === 'FIRE-DRON-0001').length === 1)
check('提醒未重复生成',
  svc.listReminders().filter((r) => r.架次编号 === 'SORT-1001').length === 1)

// ============ 7. 强制失败：三侧回退 + 缺失段续传 ============
console.log('7) 失败回退与缺失航段续传')
// 找一个干净的待执行任务：先建不了，用 DRON 已有？用新架次挂 DRON-0001 已完成不行。
// 用中止任务 DRON-0004 续传：缺失 3、4，强制失败应回退提醒/报告侧且中止态不复活。
const reportBefore = svc.listRows('firereport').length
const reminderBefore = svc.listReminders().length
const fail1 = await svc.uploadTrack({
  任务编号: 'DRON-0004', 架次编号: 'SORT-0003', 飞手姓名: '陈岭',
  总段数: 4, 完成声明: true,
  航段: [seg(3, { 飞行区域: '西岗营林区', 异常数: 2 }), seg(4, { 飞行区域: '西岗营林区' })],
  强制失败: true,
})
check('强制失败返回 ok=false', fail1.ok === false)
check('回退消息列出缺失/接收', fail1.message.includes('回退'), fail1.message)
check('失败后航段 3、4 已保留（续传依据）', JSON.stringify(fail1.已接收段) === '[1,2,3,4]', JSON.stringify(fail1.已接收段))
check('任务、报告、提醒数量回退不变',
  svc.listRows('firereport').length === reportBefore && svc.listReminders().length === reminderBefore)
const t4b = svc.listTasks().find((r) => r['任务编号'] === 'DRON-0004')
check('回退后任务仍是因故中止（不复活飞行中）', t4b.status === '因故中止', t4b.status)
check('回退后异常数不回退（异常单向，只增不减）——仍为 1', Number(t4b['发现异常数']) === 1, String(t4b['发现异常数']))

// 再次进入（重新读）从缺失航段续传——此时已无缺失，完成声明但任务已中止
const retry = await svc.uploadTrack({
  任务编号: 'DRON-0004', 架次编号: 'SORT-0003', 飞手姓名: '陈岭',
  总段数: 4, 完成声明: true,
  航段: [seg(3, { 飞行区域: '西岗营林区', 异常数: 2 }), seg(4, { 飞行区域: '西岗营林区' })],
  强制失败: false,
})
check('续传成功（幂等接收、无新增）', retry.ok === true, retry.message)
check('续传后任务保持因故中止', retry.任务状态 === '因故中止', retry.任务状态)
const t4c = svc.listTasks().find((r) => r['任务编号'] === 'DRON-0004')
check('新异常单向累加到 3', Number(t4c['发现异常数']) === 3, String(t4c['发现异常数']))
check('中止任务报告/提醒仍只各一条（已提交过不重复）',
  svc.listRows('firereport').filter((r) => r['报告编号'] === 'FIRE-DRON-0004').length === 1 &&
  svc.listReminders().filter((r) => r.架次编号 === 'SORT-0003').length === 1)

// ============ 7b. 全新架次的「部分成功→最后一批强制失败→续传成功」链路 ============
console.log('7b) 部分接收后失败再续传（用 SORT-2002 挂 DRON-0002 续传缺失 4、5）')
const f2 = await svc.uploadTrack({
  任务编号: 'DRON-0002', 架次编号: 'SORT-0001', 飞手姓名: '李远航',
  总段数: 5, 完成声明: true,
  航段: [seg(4, { 飞行区域: '北坡防火线', 异常数: 1 }), seg(5, { 飞行区域: '北坡防火线' })],
  强制失败: true,
})
check('最后一批强制失败', f2.ok === false)
const task2mid = svc.listTasks().find((r) => r['任务编号'] === 'DRON-0002')
check('失败回退后 DRON-0002 仍为飞行中', task2mid.status === '飞行中', task2mid.status)
const reports2 = svc.listRows('firereport').filter((r) => r['报告编号'] === 'FIRE-DRON-0002')
check('失败未留下报告', reports2.length === 0)
const ok2 = await svc.uploadTrack({
  任务编号: 'DRON-0002', 架次编号: 'SORT-0001', 飞手姓名: '李远航',
  总段数: 5, 完成声明: true,
  航段: [seg(4, { 飞行区域: '北坡防火线', 异常数: 1 }), seg(5, { 飞行区域: '北坡防火线' })],
  强制失败: false,
})
check('缺失航段续传成功并完成', ok2.ok === true && ok2.任务状态 === '已完成', ok2.message)
check('续传后生成报告', ok2.生成报告 === 'FIRE-DRON-0002', ok2.生成报告)
check('续传后生成提醒', Boolean(ok2.生成提醒))
const t2done = svc.listTasks().find((r) => r['任务编号'] === 'DRON-0002')
check('异常数 2（原 1 + 新 1）', Number(t2done['发现异常数']) === 2, String(t2done['发现异常数']))
check('降落时间回写', Boolean(t2done['降落时间']))
// 再重传一次完整架次 → 只生效一次
const re2 = await svc.uploadTrack({
  任务编号: 'DRON-0002', 架次编号: 'SORT-0001', 飞手姓名: '李远航',
  总段数: 5, 完成声明: true, 航段: [seg(4, { 飞行区域: '北坡防火线', 异常数: 1 }), seg(5)],
  强制失败: false,
})
check('完整架次再次上传被拒', re2.ok === false)

// ============ 8. 并发上传：第二次提交被拒绝 ============
console.log('8) 并发提交锁')
// 先重置出干净待执行任务：DRON-0003 不行，用登记的新任务——没有创建任务入口；
// 用重置后再来。改用两个不同任务并发：重置整个域。
svc.resetDrone()
const pA = svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-C1', 飞手姓名: '李远航',
  总段数: 1, 完成声明: true, 航段: [seg(1, { 飞行区域: '南坡幼林带', 异常数: 1 })], 强制失败: false,
})
await delay(50) // 确保 A 先拿到锁
const pB = svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-C2', 飞手姓名: '周慕云',
  总段数: 1, 完成声明: true, 航段: [seg(1, { 飞行区域: '南坡幼林带' })], 强制失败: false,
})
const [rA, rB] = await Promise.all([pA, pB])
check('并发第一个提交成功', rA.ok === true, rA.message)
check('并发第二个提交被拒绝', rB.ok === false && rB.message.includes('并发'), rB.message)
check('被拒并发未产生架次', svc.getSortie('SORT-C2') === undefined)

// 并发期间状态流转也被拒（锁窗口小，直接用 isUploading 场景验证不可靠，这里验证锁后恢复）
await delay(550)
check('锁在提交结束后释放', svc.isUploading() === false)

// ============ 9. 区域全部为空 → 系统补标 ============
console.log('9) 飞行区域全空的系统补标')
svc.resetDrone()
  // 手动清空 DRON-0001 区域
{
  const tasks = svc.listRows('drone').map((r) => ({ ...r }))
  const idx = tasks.findIndex((r) => r['任务编号'] === 'DRON-0001')
  tasks[idx]['飞行区域'] = ''
  svc.saveRows('drone', tasks)
}
const upEmptyRegion = await svc.uploadTrack({
  任务编号: 'DRON-0001', 架次编号: 'SORT-E1', 飞手姓名: '李远航',
  总段数: 1, 完成声明: true, 航段: [seg(1, { 飞行区域: '' })], 强制失败: false,
})
check('全空区域也能上传成功（系统补标）', upEmptyRegion.ok === true, upEmptyRegion.message)
const t1e = svc.listTasks().find((r) => r['任务编号'] === 'DRON-0001')
check('任务区域被系统补标且带标记',
  String(t1e['飞行区域']).includes('未标注空域') && t1e['区域补齐'] === true,
  String(t1e['飞行区域']))

// ============ 10. 异常核查单向提交 ============
console.log('10) 核查提醒单向')
const rem = svc.listReminders('待核查')[0]
const c1 = svc.checkReminder(rem.id, '现场确认为荒火，已扑灭', '值班管理员')
check('核查提交成功', c1.ok === true, c1.message)
const c2 = svc.checkReminder(rem.id, '想改结论', '值班管理员')
check('已核查不能重复提交', c2.ok === false)
const remAfter = svc.listReminders().find((r) => r.id === rem.id)
check('结论保持首次提交内容', remAfter.核查结论 === '现场确认为荒火，已扑灭')
check('空结论被拒绝', svc.checkReminder(svc.listReminders('待核查')[0]?.id ?? 0, '   ').ok === false)

// ============ 11. 中止时异常提交事务 ============
console.log('11) 飞行中任务中止：异常随中止单向提交')
svc.resetDrone()
{
  // DRON-0002 飞行中，已有 1 异常、架次部分段；中止 → 生成报告+提醒，状态终止
  const tasks = svc.listRows('drone')
  const t = tasks.find((r) => r['任务编号'] === 'DRON-0002')
  const res = svc.transitionTask(t.id, '中止任务')
  check('中止成功', res.ok === true, res.message)
  const after = svc.listTasks().find((r) => r['任务编号'] === 'DRON-0002')
  check('中止后状态为因故中止', after.status === '因故中止')
  check('中止时异常数保留为 1', Number(after['发现异常数']) === 1)
  check('中止生成异常报告',
    svc.listRows('firereport').some((r) => r['报告编号'] === 'FIRE-DRON-0002'))
  check('中止生成一条提醒',
    svc.listReminders().some((r) => r.架次编号 === 'SORT-0001'))
  const res2 = svc.transitionTask(t.id, '中止任务')
  check('不能重复中止', res2.ok === false)
}

// ============ 12. 统计 ============
console.log('12) 统计与列表一致')
{
  const stats = svc.droneStats()
  check('已完成任务统计为 1（种子）', stats.已完成任务 === 1, String(stats.已完成任务))
  check('发现异常数合计 4（0+1+2+1）', stats.发现异常数 === 4, String(stats.发现异常数))
  check('今日飞行任务为 3（有起飞时间的）', stats.今日飞行任务 === 3, String(stats.今日飞行任务))
}

// ============ 13. 飞手登记 ============
console.log('13) 飞手登记与查重')
{
  const ok = svc.registerPilot({ 姓名: '新飞手', 工号: 'PILOT-099', 联系方式: '138', 所属林场: '青峰林场', 资质编号: 'UAV-A-2026-099' })
  check('新飞手登记成功', ok.ok === true, ok.message)
  const dup = svc.registerPilot({ 姓名: '新飞手', 工号: 'PILOT-100', 联系方式: '138', 所属林场: '青峰林场', 资质编号: 'UAV-A-2026-100' })
  check('同名飞手重复登记被拒', dup.ok === false)
  const incomplete = svc.registerPilot({ 姓名: '', 工号: '', 联系方式: '', 所属林场: '', 资质编号: '' })
  check('信息不全被拒', incomplete.ok === false)
}

// ============ 14. 航段级校验 ============
console.log('14) 航段校验')
{
  const r1 = await svc.uploadTrack({
    任务编号: 'DRON-0001', 架次编号: 'SORT-V1', 飞手姓名: '李远航',
    总段数: 2, 完成声明: false,
    航段: [seg(1), seg(1)], 强制失败: false,
  })
  check('同批重复航段序号被拒', r1.ok === false)
  const r2 = await svc.uploadTrack({
    任务编号: 'DRON-0001', 架次编号: 'SORT-V2', 飞手姓名: '李远航',
    总段数: 2, 完成声明: false,
    航段: [seg(3)], 强制失败: false,
  })
  check('超出总段数的序号被拒', r2.ok === false)
  const r3 = await svc.uploadTrack({
    任务编号: 'DRON-0001', 架次编号: 'SORT-V3', 飞手姓名: '李远航',
    总段数: 2, 完成声明: false,
    航段: [seg(1, { 异常数: -1 })], 强制失败: false,
  })
  check('负异常数被拒', r3.ok === false)
  const r4 = await svc.uploadTrack({
    任务编号: 'DRON-0001', 架次编号: 'SORT-V4', 飞手姓名: '李远航',
    总段数: 2, 完成声明: false,
    航段: [seg(1, { 起飞时间: '' })], 强制失败: false,
  })
  check('缺起飞时间被拒（原始起降时间必须保留）', r4.ok === false)
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
