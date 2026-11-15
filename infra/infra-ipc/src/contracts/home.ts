import { z } from 'zod'

/**
 * Home 契约 —— 主页与新标签页的两个解析结果。
 *
 * 为什么要有一条专用通道：主页地址由 `app.home_mode`（newtab/home/custom）与
 * `app.home_url` 两个设置共同决定，解析逻辑在主进程的 `home-url.js` 里。
 * 壳层若要渲染「主页」按钮 / 判断地址栏是否留空，必须拿到**同一个**结果 —— 若在
 * 渲染层用 settings:get 自行拼一遍，就会出现「按钮跳的地址和启动页不一致」的两套真源。
 *
 * `url`      = 主页语义（纯设置解析）；
 * `newTabUrl` = 一张新标签实际落到的地址（newtab 档会带上扩展的
 *              `chrome_url_overrides.newtab`；无痕窗口除外）。
 * 两者在「有扩展覆盖新标签页」时不同，所以不能合并成一个字段。
 */
const homeSchemas = Object.freeze({
  url: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ url: z.string(), newTabUrl: z.string() })
  })
})

export { homeSchemas }

