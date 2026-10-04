/** 无人机巡查域模型：飞手 → 任务 → 架次/航段 → 异常 → 火情报告 → 核查提醒，沿这条数据流读写。 */

/** 飞手：航迹必须挂在册飞手，未登记飞手上传会被拒绝。 */
export type DronePilot = {
  id: number
  姓名: string
  工号: string
  联系方式: string
  所属林场: string
  资质编号: string
  状态: '在册' | '停飞'
}

/** 航段：一次上传可携带多个航段，序号在同一架次内必须唯一且连续。 */
export type TrackSegment = {
  /** 架次内航段序号，从 1 开始。 */
  seq: number
  起飞时间: string
  降落时间: string
  飞行区域: string
  航点: string
  /** 该航段发现的异常点数量，只允许非负整数，单向累加不回退。 */
  异常数: number
}

/** 已落库的航段（带服务端/持久层标记）。 */
export type StoredSegment = TrackSegment & {
  /** 系统补标飞行区域时为 true，页面上明确区分「原始」与「补齐」。 */
  区域补齐: boolean
}

/** 核查提醒：异常只能单向提交（待核查 → 已核查），不会被重复生成。 */
export type CheckReminder = {
  id: number
  提醒编号: string
  任务编号: string
  架次编号: string
  飞手姓名: string
  飞行区域: string
  异常数: number
  发现时间: string
  状态: '待核查' | '已核查'
  核查人: string
  核查时间: string
  核查结论: string
}

/** 架次：一架飞机一次起降对应一条；航段分次上传，失败后从缺失航段续传。 */
export type DroneSortie = {
  id: number
  架次编号: string
  任务编号: string
  飞手id: number
  飞手姓名: string
  /** 计划航段总数，上传的航段序号必须落在 1..总段数。 */
  总段数: number
  /** 已接收航段序号集合（落盘即保留，失败回退不清空——这是续传的依据）。 */
  已接收段: number[]
  航段: StoredSegment[]
  /** 飞手上传时声明的原始起降时间，首传落库后永不覆盖。 */
  原始起飞时间: string
  原始降落时间: string
  /** 已累计异常数：单向累加，重复上传同一航段不重复计数。 */
  异常数: number
  /** 是否已生成过火情报告/核查提醒（一次架次只生成一次）。 */
  已提交异常: boolean
  关联报告编号: string
  关联提醒id: number
  /** 飞手声明该架次全部航段已传完；中止的任务不再自动收口。 */
  完成声明: boolean
  /**
   * 已收口：航段齐全且任务/报告/提醒事务已成功提交。
   * 失败回退时即使航段已全部接收也保持 false —— 此时允许重传来补做提交（从缺失航段续传）。
   */
  已收口: boolean
  完成时间: string
  创建时间: string
  最近上传时间: string
  最近批次: number
  上传日志: { 时间: string; 批次: number; 接收段: number[]; 结果: string }[]
}

/** 上传航迹入参。 */
export type UploadTrackInput = {
  任务编号: string
  架次编号: string
  飞手姓名: string
  总段数: number
  完成声明: boolean
  航段: TrackSegment[]
  /** 演示用：强制本批次在提交阶段失败，触发任务/报告/提醒回退与缺失航段续传。 */
  强制失败: boolean
}

export type UploadTrackResult = {
  ok: boolean
  message: string
  架次编号: string
  本批接收: number[]
  已接收段: number[]
  缺失段: number[]
  异常数: number
  任务状态: string
  生成报告: string
  生成提醒: string
}

export type DroneStats = {
  今日飞行任务: number
  已完成任务: number
  发现异常数: number
}
