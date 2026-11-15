// @ts-check
/**
 * @hira-ng/ui-capture-editor —— 截图标注编辑器（**三种截图方式共用**）。
 *
 * 「可见区域 / 整页 / 选区」取到图之后都进这一个**浏览器窗口内浮层**：画矩形 / 椭圆 /
 * 箭头 / 画笔 / 高亮 / 文字 / 马赛克 / 模糊，撤销重做，复制到剪贴板或另存为 PNG。
 *
 * 包结构：
 *   src/shared/styles.ts   三层浮层样式（画布 / 文档 / 控制层）
 *   src/window/layout.ts   纯几何：画布适应、缩放、平移与工具栏安全落点
 *   src/window/toolbar.ts  可独立替换的控制栏视图
 *   src/window/painters.ts 工具 → 画笔注册表
 *   src/window/index.ts    画布、交互、导出与各模块编排
 *
 * 本包不认识 IPC、不认识 Electron：取图、复制、保存、收起全部从宿主注入的 `ctx` 进来。
 */

export { captureEditorDefinition, createCaptureEditor, injectCaptureEditorStyles } from './window/index.js'
export type {
  CaptureEditorContext,
  CaptureEditorController,
  CaptureEditorPreferences,
  CapturePreferencesPort,
  CaptureLoadResult
} from './window/index.js'
export { PAINTERS, registerPainter, paintOp } from './window/painters.js'
export type { CaptureOp, CapturePainter, CapturePoint } from './window/painters.js'
