/**
 * theme-client.js —— 主题域客户端（渲染层薄壳）。
 *
 * 真正的请求面（通道名 + 载荷形状 + 全部方法）收在
 * `@hira-ng/shared-types/src/themes/client.js#createThemeClient` —— 主题内部页
 * （`hira://themes`）用的是**同一份**，只是把端口换成 `runtime.js` 的 rpc/subscribe。
 * 于是"页面里能保存、面板里保存报错"这类裂缝在结构上就不存在。
 *
 * 本文件只负责把渲染层的两个端口接上，不再重复一份方法表：
 *   invoke    → `getHiraBridge().provider.invoke`
 *   subscribe → `bridge.on.subscribe`
 */

import { createThemeClient } from '@hira-ng/shared-types/src/themes/client.js'
import { getHiraBridge } from './bridge.js'

export const themeClient = createThemeClient({
  invoke(route, arg) {
    return getHiraBridge().provider.invoke(route, arg)
  },
  subscribe(event, handler) {
    const bridge = getHiraBridge()
    if (!bridge || !bridge.on || typeof bridge.on.subscribe !== 'function') return () => {}
    return bridge.on.subscribe(event, handler)
  }
})
