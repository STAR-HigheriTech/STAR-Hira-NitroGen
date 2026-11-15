/**
 * update-settings.mjs —— 软件更新的**唯一真源**（设置键名 + 缺省值 + 通道词表 + 周期护栏）
 *
 * 谁用它：
 *   - `domain/domain-settings`：默认值表 + 周期上下界；
 *   - `apps/app-main/src/main/update/service.js`：读设置、通道映射、定时器计算；
 *   - `apps/app-main/src/pages/about/update-panel.js`：更新面板的偏好读写与通道按钮。
 *
 * 为什么通道词表也在这里：通道 id 同时出现在「设置默认值」「服务端 CHANNEL_PROFILES」
 * 「更新面板按钮」三处，任何一处手抄都可能出现"按钮能点、服务不认"。
 * 通道的 updater 参数（latest / preview / 预发布语义）是 electron-updater 的实现细节，
 * 仍留在服务里 —— 本文件只管**对用户可见的 id 与文案**。
 */

/** 设置键名。 */
export const UPDATE_SETTING_KEYS = Object.freeze({
  /** 是否允许后台静默检查（关掉后只能手动点）。 */
  autoCheck: 'update.auto_check',
  /** 检查周期（小时）。 */
  intervalHours: 'update.interval_hours',
  /** 发布通道 id（取值必须来自 `UPDATE_CHANNELS`）。 */
  channel: 'update.channel',
  /** 上次检查完成时间（毫秒时间戳）—— 跨重启维持周期语义。 */
  lastCheckAt: 'update.last_check_at'
})

/** 通道 id（消费者需要按 id 查表时用，避免手抄字符串）。 */
export const UPDATE_CHANNEL_IDS = Object.freeze({
  stable: 'stable',
  preview: 'preview'
})

/**
 * 发布通道（顺序即更新面板里的按钮顺序，首项为缺省通道）。
 * `hint` 是更新面板里"切到这条通道意味着什么"的一句话解释。
 */
export const UPDATE_CHANNELS = Object.freeze([
  Object.freeze({ id: UPDATE_CHANNEL_IDS.stable, label: '稳定版', hint: '只接收正式发布（latest 通道）。' }),
  Object.freeze({ id: UPDATE_CHANNEL_IDS.preview, label: '预览版', hint: '接收预发布构建，可能包含未稳定的改动。' })
])

/** 周期护栏：域层校验与更新面板输入框共用同一组上下界。 */
export const UPDATE_INTERVAL_LIMITS = Object.freeze({
  min: 1,
  /** 一年，防手滑。 */
  max: 8760
})

/** 设置缺省值。 */
export const DEFAULT_UPDATE_SETTINGS = Object.freeze({
  [UPDATE_SETTING_KEYS.autoCheck]: true,
  /** 1440 小时 = 约 2 个月（低频静默检查）。 */
  [UPDATE_SETTING_KEYS.intervalHours]: 1440,
  [UPDATE_SETTING_KEYS.channel]: UPDATE_CHANNELS[0].id,
  [UPDATE_SETTING_KEYS.lastCheckAt]: 0
})
