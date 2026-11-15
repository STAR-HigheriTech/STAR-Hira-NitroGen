/**
 * panel-generic —— 面板插件的通用入口（10 个 panel-* 插件共用）。
 *
 * 这个文件是**空实现**，而且是刻意的：面板插件的全部信息都已经在它的
 * `hira-plugin.json` 里声明完了 ——
 *
 *   · `contributes.panels`  → 面板 id / 中文名 / 图标 / 顺序 / 所属段
 *                             （主进程面板目录的唯一事实源，见 main/panel-catalog.js）
 *   · `dependsOn`           → 前置依赖（side-panel-skeleton，CONTRACT-07）
 *
 * 也就是说：「多一个面板」= 多一个 manifest + 一个 `ui/ui-panel-*` 包，
 * **主进程与渲染层都不需要写任何代码**。插件入口这里没有要执行的东西，
 * 所以 install/enable/disable/uninstall 全部为空。
 *
 * 对齐 RT：**绝不在 enable 时创建 / 加载面板 WebContentsView**。
 * 面板视图与内容一律延迟到「首次真正显示」时由
 *   LayoutCoordinator.showPanel() → WebContentsManager.loadPanel()
 * 惰性创建。启动期不再多拉起 10 个面板渲染进程（这是「跟 IE 一样卡」的主要来源之一）。
 */
module.exports = {
  install() {},

  enable() {},

  disable() {},

  uninstall() {}
}
