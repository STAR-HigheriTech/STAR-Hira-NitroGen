/**
 * TOTP / HOTP 的可编辑参数 —— **唯一真源**。
 *
 * ── 为什么放在 packages/shared-types ────────────────────────────────────
 * 同一组取值有**两层**消费方，且加载方式不同：
 *   · 领域层（`domain/domain-totp/src/index.ts`）—— TypeScript 源码，构建为 CJS，用于"存进去之前收窄"；
 *   · 渲染层验证器面板（`apps/app-main/plugins/panel-totp.view.js`）—— vite 打包，
 *     用于生成三张下拉（算法 / 位数 / 周期）。
 * 以前两处各抄一份，后果是"领域层放行的值，界面上永远选不到"或反之 —— 两边都不报错，
 * 只表现为"存进去的条目在某个验证器上码不对"。清单变更现在只改这一处。
 *
 * ── 为什么刻意收窄（不是抄 otpauth 的完整能力）─────────────────────────
 * otpauth 支持 SHA224/384/512 甚至 SHA3，但：
 *   · 各家验证器实际只认 SHA1（默认）/ SHA256 / SHA512；
 *   · Microsoft Authenticator 干脆**忽略** URI 里的 algorithm/digits/period，
 *     永远按 SHA1+6+30 算。放行它不认的值，只会造出"在这个 App 对、在那个 App 错"的条目。
 * 收窄在这里 = 存进去的每一条都是跨 App 能对上的。
 *
 * 纯数据、零依赖、不碰 DOM。
 */

/** 允许的算法（顺序即下拉顺序，SHA1 在前 = 绝大多数条目的默认）。 */
export const TOTP_ALGORITHMS = Object.freeze(['SHA1', 'SHA256', 'SHA512'])

/** 允许的位数（6 位是事实标准，8 位少量银行 / 企业条目在用）。 */
export const TOTP_DIGITS = Object.freeze([6, 8])

/**
 * 下拉里可选的周期（秒）。
 *
 * 注意它与上面两张表**不是同一类约束**：领域层对导入的条目接受"任意正整数周期"
 * （Google 迁移包里就有非 30/60 的条目，硬卡会把合法条目改成错码），这里只是
 * "手工新建时给用户的两个常见档"。所以本常量只服务界面，不要拿去当校验白名单。
 */
export const TOTP_PERIODS = Object.freeze([30, 60])
