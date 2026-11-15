import { z } from 'zod'

/**
 * ScreenCapture 契约 —— 「抓一帧屏幕」的窄通道。
 *
 * ── 为什么像素要在契约里写清格式（而不是"一个 Buffer 自己猜"）──────────
 * 桌面抓帧在 Windows 上给的是 **BGRA**（原生位图顺序），而 `ImageData` 要 RGBA。
 * 这件事必须写在契约上：否则消费方只能靠"看起来颜色不对"去发现，
 * 而下一处改动（换平台 / 换 API）会把这个隐式假设打破得无声无息。
 *
 * 对本功能无害且刻意接受：二维码是**单色**的（R=G=B），R/B 互换对灰度化没有影响。
 * 所以这里不做逐像素翻转（1920×1080 翻一遍是白烧 8ms 主进程时间）。
 *
 * ── 尺寸上限 ──────────────────────────────────────────────────────────
 * 抓帧按"长边 ≤ 1920"取。4K 屏整屏原始位图是 33MB，每 0.6 秒一份既费内存也费 IPC；
 * 而二维码在 1920 宽的画面里足够解出来（见 screen.js 的说明）。
 */

/** 一次抓帧的像素载荷。 */
const frameSchema = z.object({
  ok: z.boolean(),
  reason: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  /**
   * 是否已按**扫码浮框**裁剪。
   *
   * 为什么这个布尔要回传：浮框是可以被用户直接关掉的（框上的 ✕），
   * 关掉之后主进程会退化成整屏抓帧 —— 面板据此知道"浮框没了"，
   * **自动停止扫描**，而不是让用户对着一个不存在的框继续等。
   */
  framed: z.boolean().optional(),
  /**
   * 取景框正在被拖动 / 缩放 —— 此时**没有抓屏**，这一帧作废。
   *
   * 为什么要在协议里表达"我这一帧没干活"：抓屏是主进程上最重的一步（整屏回读 + 大块
   * IPC），和"用户正在拖框"叠在一起就是"拖不动"。所以交互期间主进程**直接短路返回
   * busy**，一秒的活都不干。消费方（扫码轮询）据此安静跳过这一拍：
   * 不是错误、不计数、不提示 —— 用户松手后自然会继续。
   */
  busy: z.boolean().optional(),
  /**
   * 原始像素（BGRA，长度 = width*height*4）。
   * 用 `Uint8Array` 而不是 base64：结构化克隆走的是二进制通道，
   * 换成字符串要多一次编码 + 多 33% 体积。
   */
  data: z.instanceof(Uint8Array).optional()
})

const screenSchemas = Object.freeze({
  /**
   * 抓一帧。
   *
   * **扫哪一块由取景框决定**：浮框开着时抓它所在的那块屏、裁到框内
   * （此时 `displayId` 被忽略 —— 用户在框里看到哪儿，扫的就是哪儿）。
   * 浮框没开时抓 `displayId` 指定的屏，省略则抓光标所在的那块。
   *
   * 失败（没有可用的抓帧后端 / 画面为空 / 框被拖到屏幕外）是**正常结果**，
   * 用 `ok:false + reason` 表达而不是 reject —— 与 totp 的写操作同一条取舍：
   * 用户要看到原因。
   */
  capture: Object.freeze({
    request: z.object({ displayId: z.string().optional() }),
    response: frameSchema
  }),

  /** 打开 / 关闭扫码浮框。返回值带上"关完之后它还在不在"，避免调用方自己猜。 */
  frameOpen: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean(), open: z.boolean().optional(), reason: z.string().optional() })
  }),
  frameClose: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({ ok: z.boolean(), open: z.boolean().optional(), reason: z.string().optional() })
  }),

  /**
   * 拖框 / 缩放框 —— 渲染层只报**意图**，几何由主进程算。
   *
   * ```
   * { mode: 'move' | 'resize', edge?: 'tl'|'tr'|'bl'|'br', dx, dy }
   * ```
   *
   * `dx/dy` 是"光标从按下到现在的**总位移**"。三条边界都写在这里：
   *
   * · **不是目标矩形**：窗口矩形只有主进程是权威（`getBounds()`）。渲染层量出来的
   *   矩形（`window.screenX` / `innerWidth`）与 `setBounds` 的坐标系在缩放的显示器上
   *   并不总是同一个数 —— 一旦不一致，第一次落位就会把窗口"跳"到一个偏大的尺寸，
   *   用户看到的就是**"按住一下就自己变大"**（本契约之所以长成这样，就是为了根治它）。
   * · **不是增量**：增量累加会因丢帧 / 舍入一路漂移。主进程在按下那一刻记一次基准矩形，
   *   之后一律 `基准 + 总位移` 重算 —— 永远与光标对齐，且与帧率无关。
   * · **resize 与 move 共用一条**：区别只在 `mode`。move 只平移（与几何常量无关），
   *   resize 会改变裁剪区（所有解码的输入）—— 由主进程一处夹取下限。
   */
  frameDrag: Object.freeze({
    request: z.object({
      mode: z.enum(['move', 'resize']),
      /** 缩放的角（`move` 时省略）：**对角保持不动**。 */
      edge: z.enum(['tl', 'tr', 'bl', 'br']).optional(),
      dx: z.number(),
      dy: z.number()
    }),
    /** 回传落位后的矩形：调用方（取景框页）不需要它，留作诊断与"谁在改窗口"的对照。 */
    response: z.object({
      ok: z.boolean(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional()
    })
  }),

  /**
   * 上报"用户正在拖动 / 缩放"。
   *
   * 这是**暂停抓屏**的唯一开关（见 frame 的 busy 字段）。为什么由渲染层上报而不是
   * 主进程从 `move`/`resize` 事件推断：拖动可能有一段时间没有位移（手指按住不动），
   * 而"是否处于交互中"只有渲染层知道得最准（mousedown/mouseup 就在它手里）。
   */
  frameInteract: Object.freeze({
    request: z.object({ active: z.boolean() }),
    response: z.object({ ok: z.boolean() })
  }),

  /**
   * 取景框的几何快照 —— **只有矩形，没有像素**。
   *
   * 给"渲染进程自己抓屏"（`getDisplayMedia` 屏幕流 + canvas 裁剪）那条路用：
   * 流是整屏的，渲染层必须知道"框在流里的哪一块"。而几何权威只在主进程
   * （见 frameDrag 的三条边界），所以这里只把结果交出来，不让渲染层自己算。
   */
  frameGeometry: Object.freeze({
    request: z.unknown().optional(),
    response: z.object({
      ok: z.boolean(),
      /**
       * 要解码的那一块（屏幕 DIP 坐标，已含取景框内边距）—— `qrScanCropRect()` 的产物。
       * 框不在屏幕内时为 null（调用方据此报"把框拖回来"）。
       */
      crop: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(),
      /** 框所在显示器的矩形（DIP）。`crop` 减它就是"流内相对坐标"。 */
      display: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().optional(),
      /** 框是否开着 —— 关着时流就不该被使用（见 main 的 displayMedia 处理器）。 */
      open: z.boolean().optional(),
      reason: z.string().optional()
    })
  })
})

export { screenSchemas }

