/**
 * TOTP 域插件 —— 声明式能力表（kernel 机制见 infra-plugin/service-plugin.js）。
 *
 * 与 notes-service.cjs 同构：域方法为事实源，provider 只做「能力 → 方法」的薄映射。
 *
 * ⚠ 这八条能力名与三处**必须逐字一致**：
 *   ① 本文件 `capabilities` 的键
 *   ② `totp-service.hira-plugin.json` 的 `capabilities` 数组
 *      （不一致 → `plugin:coverage` 报错；而漏声明的后果是"插件被禁用后能力仍可用"）
 *   ③ `main/ipc/totp.js` 里 `invoke('totp.xxx', ...)` 的第一个参数
 *      （不一致 → 能力注册了却没人调得到）
 *
 * 出厂默认关闭（manifest 的 `defaultDisabled`）：这个插件不启用时，
 * 上面这些能力全被 `isCapabilityBlocked` 拦下，**不回落域服务** —— 功能是真的没了，
 * 而不是"入口没了但 IPC 还能调"。验证器面板因 `dependsOn` 落 blocked → 面板从目录消失。
 */
import { createServicePlugin } from '@hira-ng/infra-plugin'
import type { TotpService } from '@hira-ng/domain-totp'
import type { TotpInputs } from './service-contracts'

module.exports = createServicePlugin<TotpService, TotpInputs>({
  domain: 'totp',
  serviceName: 'totpService',
  capabilities: {
    /** 条目列表（**不含密钥**，域层出口已剥离） */
    'totp.list': (svc) => svc.list(),
    /**
     * 当前验证码。带 id 只算那一条。
     * 响应是 `{ codes:[{id,code,type,remaining,period}], now, unavailable }` ——
     * 渲染层拿 `now` 对齐倒计时，且**永远拿不到密钥**。
     */
    'totp.code': (svc, input) => svc.code(input || {}),
    /** 手动新增一条（`input.secret` 是明文 base32，只在写入方向出现） */
    'totp.add': (svc, input) => svc.add(input),
    /** 改元信息；`input.secret` 传了才改密钥 */
    'totp.update': (svc, input) => svc.update(input.id, input),
    'totp.remove': (svc, input) => svc.remove(input.id),
    /** 批量导入：只收 `otpauth://` URI（各家格式→URI 的转换在渲染层，见设计文档 §5.5） */
    'totp.import': (svc, input) => svc.importUris(input || {}),
    /**
     * ⚠ 唯一会把密钥交出去的：返回含 secret 的 `otpauth://` URI。
     * 单独成一个能力（而不是并进 list）就是为了让它可审计、可单独收紧。
     */
    'totp.exportUri': (svc, input) => svc.exportUri(input.id),
    /**
     * 联网校准本机时钟偏差（`{ reset: true }` = 清掉偏移、回到纯本机时间）。
     * 偏移持久化在全局库 `kv`（不随 profile 走），算码时叠加 —— 只影响验证码，不动系统时间。
     */
    'totp.calibrate': (svc, input) => svc.calibrate(input || {})
  }
})
