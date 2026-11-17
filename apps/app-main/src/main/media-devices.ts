import {
  BrowserWindow,
  desktopCapturer,
  dialog,
  webContents as electronWebContents,
  type DesktopCapturerSource,
  type Session,
  type WebContents
} from 'electron'
import { onWebContentsDestroyed } from '@hira-ng/infra-window'

interface DisplayMediaRequestLike {
  frame?: unknown
  audioRequested?: boolean
  videoRequested?: boolean
}

interface DeviceLike {
  deviceId?: string
  portId?: string
  deviceName?: string
  name?: string
  portName?: string
  displayName?: string
  vendorId?: number | string
  productId?: number | string
  manufacturer?: string
  productName?: string
  serialNumber?: string
}

interface DeviceDetailsLike {
  frame?: unknown
  deviceList?: DeviceLike[]
  portList?: DeviceLike[]
}

type SelectionCallback = (value?: string) => void
let displayPromptTail: Promise<unknown> = Promise.resolve()

function contentsFromFrame(frame: unknown): WebContents | null {
  try {
    const fromFrame = (electronWebContents as unknown as {
      fromFrame?: (value: unknown) => Electron.WebContents | null
    }).fromFrame
    return fromFrame ? fromFrame(frame) : null
  } catch {
    return null
  }
}

function ownerFromFrame(frame: unknown): BrowserWindow | null {
  const contents = contentsFromFrame(frame)
  if (contents) {
    try { return BrowserWindow.fromWebContents(contents) } catch {}
  }
  return BrowserWindow.getFocusedWindow()
}

async function chooseIndex(
  owner: BrowserWindow | null,
  title: string,
  message: string,
  labels: string[]
): Promise<number | null> {
  if (labels.length === 0) return null
  const buttons = [...labels, '取消']
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title,
    message,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true
  }
  const result = owner && !owner.isDestroyed()
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return result.response >= 0 && result.response < labels.length ? result.response : null
}

async function chooseDisplayMediaSourceNow(
  request: DisplayMediaRequestLike
): Promise<{ video: DesktopCapturerSource; audio?: 'loopback' } | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
  if (!sources.length) return null
  const owner = ownerFromFrame(request.frame)
  const labels = sources.map((source, index) => {
    const kind = source.id.startsWith('screen:') ? '屏幕' : '窗口'
    return `${index + 1}. ${kind} · ${source.name || '未命名来源'}`
  })
  const index = await chooseIndex(owner, '共享屏幕', '选择要共享的屏幕或窗口', labels)
  if (index == null) return null
  const video = sources[index]
  if (!video) return null
  return process.platform === 'win32' && request.audioRequested === true
    ? { video, audio: 'loopback' }
    : { video }
}

export function chooseDisplayMediaSource(
  request: DisplayMediaRequestLike
): Promise<{ video: DesktopCapturerSource; audio?: 'loopback' } | null> {
  const next = displayPromptTail.then(
    () => chooseDisplayMediaSourceNow(request),
    () => chooseDisplayMediaSourceNow(request)
  )
  displayPromptTail = next.catch(() => null)
  return next
}

function deviceLabel(kind: string, device: DeviceLike, index: number): string {
  const name = String(device.deviceName || device.name || device.displayName || device.portName || `${kind} ${index + 1}`)
  const vendor = device.vendorId == null ? '' : `VID ${device.vendorId}`
  const product = device.productId == null ? '' : `PID ${device.productId}`
  const serial = device.serialNumber ? `SN ${device.serialNumber}` : ''
  return [name, [vendor, product, serial].filter(Boolean).join(' · ')].filter(Boolean).join(' — ')
}

async function selectDevice(
  kind: string,
  frame: unknown,
  devices: DeviceLike[]
): Promise<string | undefined> {
  const labels = devices.map((device, index) => deviceLabel(kind, device, index))
  if (!labels.length) return undefined
  const index = await chooseIndex(ownerFromFrame(frame), `选择${kind}设备`, `网页请求连接${kind}设备`, labels)
  if (index == null) return undefined
  const device = devices[index]
  return String(device?.deviceId || device?.portId || device?.portName || '') || undefined
}

export function attachDeviceSelectionHandlers(session: Session): () => void {
  const target = session as unknown as {
    on(event: string, listener: (...args: unknown[]) => void): unknown
    removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  }
  let disposed = false
  let promptTail = Promise.resolve()
  let bluetoothTimer: ReturnType<typeof setTimeout> | null = null
  interface SelectionRequest {
    rawCallback: SelectionCallback
    frame: unknown
    devices: DeviceLike[]
    cancelValue?: string
    settled: boolean
    offDestroyed: () => void
  }
  interface BluetoothRequest extends SelectionRequest {
    deadlineAt: number
  }
  const requests = new Set<SelectionRequest>()
  let bluetoothState: BluetoothRequest | null = null
  let bluetoothRequest: BluetoothRequest | null = null

  const logFailure = (error: unknown): void => {
    console.warn('[devices] selector failed:', error instanceof Error ? error.message : error)
  }

  const settleRequest = (request: SelectionRequest | null, value?: string): void => {
    if (!request || request.settled) return
    request.settled = true
    requests.delete(request)
    if (bluetoothRequest === request) bluetoothRequest = null
    request.offDestroyed()
    request.offDestroyed = () => {}
    try { request.rawCallback(value === undefined ? request.cancelValue : value) } catch (error) { logFailure(error) }
  }

  const createRequest = (
    rawCallback: unknown,
    frame: unknown,
    devices: DeviceLike[],
    cancelValue?: string,
    sourceOverride: WebContents | null = null
  ): SelectionRequest | null => {
    if (typeof rawCallback !== 'function') {
      console.warn('[devices] selector callback is unavailable')
      return null
    }
    const source = sourceOverride || contentsFromFrame(frame)
    const request: SelectionRequest = {
      rawCallback: rawCallback as SelectionCallback,
      frame,
      devices,
      cancelValue,
      settled: false,
      offDestroyed: () => {}
    }
    requests.add(request)
    if (source) {
      request.offDestroyed = onWebContentsDestroyed(source, () => settleRequest(request))
    }
    return request
  }

  const enqueue = (kind: string, request: SelectionRequest | null): void => {
    if (!request || request.settled) return
    const run = async (): Promise<void> => {
      if (disposed || request.settled) {
        settleRequest(request)
        return
      }
      let selected: string | undefined
      try {
        selected = await selectDevice(kind, request.frame, request.devices)
      } catch (error) {
        logFailure(error)
      } finally {
        settleRequest(request, selected)
      }
    }
    promptTail = promptTail.then(run, run).catch(logFailure)
  }

  const beginSelection = (
    kind: string,
    rawEvent: unknown,
    frame: unknown,
    devices: DeviceLike[],
    rawCallback: unknown,
    source: WebContents | null = null,
    cancelValue?: string
  ): void => {
    if (disposed) {
      if (typeof rawCallback === 'function') {
        try { (rawCallback as SelectionCallback)(cancelValue) } catch {}
      }
      return
    }
    const event = rawEvent as { preventDefault?(): void }
    event.preventDefault?.()
    enqueue(kind, createRequest(rawCallback, frame, devices, cancelValue, source))
  }

  const handleHid = (rawEvent: unknown, rawDetails: unknown, rawCallback: unknown): void => {
    const details = (rawDetails || {}) as DeviceDetailsLike
    beginSelection(
      'HID',
      rawEvent,
      details.frame,
      Array.isArray(details.deviceList) ? details.deviceList : [],
      rawCallback
    )
  }

  const handleUsb = (rawEvent: unknown, rawDetails: unknown, rawCallback: unknown): void => {
    const details = (rawDetails || {}) as DeviceDetailsLike
    beginSelection(
      'USB',
      rawEvent,
      details.frame,
      Array.isArray(details.deviceList) ? details.deviceList : [],
      rawCallback
    )
  }

  const handleSerial = (
    rawEvent: unknown,
    rawPorts: unknown,
    source: WebContents | null,
    rawCallback: unknown
  ): void => {
    beginSelection(
      '串行',
      rawEvent,
      null,
      Array.isArray(rawPorts) ? rawPorts as DeviceLike[] : [],
      rawCallback,
      source && typeof source.isDestroyed === 'function' && !source.isDestroyed() ? source : null,
      ''
    )
  }

  const handleBluetooth = (rawEvent: unknown, rawDetails: unknown, rawCallback: unknown): void => {
    if (disposed) {
      if (typeof rawCallback === 'function') {
        try { (rawCallback as SelectionCallback)('') } catch {}
      }
      return
    }
    const event = rawEvent as { preventDefault?(): void }
    const details = Array.isArray(rawDetails)
      ? { deviceList: rawDetails as DeviceLike[], frame: undefined }
      : (rawDetails || {}) as DeviceDetailsLike
    event.preventDefault?.()
    const devices = Array.isArray(details.deviceList) ? details.deviceList : []
    if (bluetoothRequest && bluetoothRequest.rawCallback !== rawCallback) {
      settleRequest(bluetoothRequest)
      bluetoothState = null
    }
    if (!bluetoothRequest) {
      const request = createRequest(rawCallback, details.frame, devices, '')
      if (!request) return
      bluetoothRequest = Object.assign(request as BluetoothRequest, {
        deadlineAt: Date.now() + 1200
      })
      bluetoothState = bluetoothRequest
    } else {
      bluetoothRequest.frame = details.frame
      bluetoothRequest.devices = devices
    }
    if (!bluetoothState) return
    if (bluetoothTimer) clearTimeout(bluetoothTimer)
    const delay = Math.max(0, Math.min(350, bluetoothState.deadlineAt - Date.now()))
    bluetoothTimer = setTimeout(() => {
      bluetoothTimer = null
      const pending = bluetoothState
      bluetoothState = null
      if (!pending) return
      enqueue('蓝牙', pending)
    }, delay)
  }

  target.on('select-hid-device', handleHid as (...args: unknown[]) => void)
  target.on('select-serial-port', handleSerial as (...args: unknown[]) => void)
  target.on('select-usb-device', handleUsb as (...args: unknown[]) => void)
  target.on('select-bluetooth-device', handleBluetooth as (...args: unknown[]) => void)

  return () => {
    if (disposed) return
    disposed = true
    if (bluetoothTimer) clearTimeout(bluetoothTimer)
    bluetoothTimer = null
    if (bluetoothState) {
      settleRequest(bluetoothState)
      bluetoothState = null
    }
    for (const request of [...requests]) settleRequest(request)
    target.removeListener('select-hid-device', handleHid as (...args: unknown[]) => void)
    target.removeListener('select-serial-port', handleSerial as (...args: unknown[]) => void)
    target.removeListener('select-usb-device', handleUsb as (...args: unknown[]) => void)
    target.removeListener('select-bluetooth-device', handleBluetooth as (...args: unknown[]) => void)
  }
}
