/**
 * 受信任公钥的**信任级别**（`official → community → local`）—— 唯一真源。
 *
 * ⚠ 别与插件 manifest 里的 `trustLevel`（`internal` / `core` / `community`）混为一谈：
 *   那个说的是「插件本身由谁发布」，这里说的是「用来验签的公钥存放在哪一级目录」。
 *
 * **顺序即查找优先级**：同一个 keyId 在多个级别里都存在时，靠前的胜出
 * （见 `plugin-installer#findTrustedKey`）。三级各有实际后果：
 *   · `official`  随应用分发（`resources/plugin-trust/`），界面不可写、不可移除；
 *   · `community` 用户导入的作者公钥，可移除；
 *   · `local`     用户自己生成 / 开发用的公钥，可移除。
 *
 * 纯数据、零依赖：主进程（CJS）、IPC 契约（zod enum）、插件面板（ESM）引同一份，
 * 谁都不许再手抄这三个字符串。
 */
export const PLUGIN_TRUST_LEVELS = Object.freeze(['official', 'community', 'local'])
