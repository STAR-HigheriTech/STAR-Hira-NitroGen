/**
 * 「集锦 Office 导出」的**主进程入口** —— 刻意是空的。
 *
 * 这个插件的全部行为都在渲染层：它通过 `note.export-format` 插槽贡献两个
 * provider（xlsx / docx），序列化发生在面板进程里（那里直接拿得到卡片数组）。
 * 主进程侧不需要注册能力、不需要读盘、不需要 IPC —— 落盘仍走宿主既有的
 * `note:export-file` 通道（见 main/notes-export-file.js 的 encoding 分支）。
 *
 * 那为什么还要这个文件：插件注册中心对非纯数据插件要求一个 main 入口
 * （见 infra-plugin/src/plugin-registry-v2.ts#loadModule），生命周期三件套
 * 必须存在。**这个入口的存在本身只是契约需要，不是实现需要** ——
 * 不要往这里塞导出逻辑，否则"序列化在渲染层"的唯一真源就被拆成两半了。
 */

module.exports = {
  install() {},
  enable() {},
  disable() {}
}
