import { useEffect, useRef, useState } from 'react'
import type { DeckGrid } from '@vibraxis/shared/vdap'
import type { WaveformBands } from '../audio/waveform'
import { formatTime } from '../audio/audioMath'

export type WaveformPad = {
  slot: number
  label: string
  sourceSeconds: number
}

type Props = {
  deckId: 'A' | 'B'
  accent: 'cyan' | 'magenta'
  waveform: WaveformBands | null
  waveformStatus: 'idle' | 'building' | 'ready' | 'failed'
  waveformFailureReason: string | null
  grid: DeckGrid | null
  gridStatus: 'idle' | 'loading' | 'ready' | 'failed'
  gridFailureReason: string | null
  pads: WaveformPad[]
  duration: number
  position: number
  loaded: boolean
  estimatedGrid: boolean
  gridConfidence: number | null
  onSeek: (seconds: number) => void
}

const BAND_COLORS = {
  low: [245, 130, 40],
  mid: [70, 210, 95],
  high: [45, 190, 245],
} as const

const ZOOM_BARS = [4, 8, 16, 32] as const
type ZoomBars = (typeof ZOOM_BARS)[number]

/** Source-time width: bars × beats-per-bar × 60 / analyzed BPM. */
export function waveformWindowSeconds(grid: DeckGrid | null, bars: ZoomBars): number {
  if (grid) {
    if (!Number.isFinite(grid.bpm) || grid.bpm <= 0) throw new RangeError('Grid BPM must be positive.')
    if (!Number.isInteger(grid.beatsPerBar) || grid.beatsPerBar < 1) {
      throw new RangeError('Grid beatsPerBar must be a positive integer.')
    }
    return bars * grid.beatsPerBar * (60 / grid.bpm)
  }
  return bars * 2
}

export function waveformPlaceholder(
  loaded: boolean,
  status: Props['waveformStatus'],
  failureReason: string | null,
): string {
  if (!loaded || status === 'idle') return 'NO TRACK LOADED'
  if (status === 'failed') return `WAVEFORM FAILED: ${failureReason ?? 'Unknown failure.'}`
  return 'BUILDING WAVEFORM…'
}

export function gridStatusLabel(
  status: Props['gridStatus'],
  failureReason: string | null,
): string | null {
  if (status === 'loading') return 'グリッド読込中'
  if (status === 'failed') return `グリッド失敗: ${failureReason ?? '原因不明'}`
  return null
}

function prepareCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, canvas.clientWidth)
  const height = Math.max(1, canvas.clientHeight)
  const pixelWidth = Math.round(width * dpr)
  const pixelHeight = Math.round(height * dpr)
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return { ctx, width, height }
}

function drawBands(
  ctx: CanvasRenderingContext2D,
  waveform: WaveformBands,
  width: number,
  height: number,
  startSeconds: number,
  endSeconds: number,
): void {
  const sourceDuration = waveform.durationSeconds || 1
  const visibleDuration = Math.max(0.001, endSeconds - startSeconds)
  const midY = height / 2

  for (let x = 0; x < width; x += 1) {
    const t0 = startSeconds + (x / width) * visibleDuration
    const t1 = startSeconds + ((x + 1) / width) * visibleDuration
    if (t1 < 0 || t0 > sourceDuration) continue
    const first = Math.max(0, Math.floor((Math.max(0, t0) / sourceDuration) * waveform.bins))
    const last = Math.min(
      waveform.bins - 1,
      Math.max(first, Math.ceil((Math.min(sourceDuration, t1) / sourceDuration) * waveform.bins)),
    )

    let peak = 0
    let low = 0
    let mid = 0
    let high = 0
    let count = 0
    for (let bin = first; bin <= last; bin += 1) {
      peak = Math.max(peak, waveform.peak[bin])
      low += waveform.low[bin]
      mid += waveform.mid[bin]
      high += waveform.high[bin]
      count += 1
    }
    low /= count || 1
    mid /= count || 1
    high /= count || 1
    const total = low + mid + high || 1
    const red = (low * BAND_COLORS.low[0] + mid * BAND_COLORS.mid[0] + high * BAND_COLORS.high[0]) / total
    const green = (low * BAND_COLORS.low[1] + mid * BAND_COLORS.mid[1] + high * BAND_COLORS.high[1]) / total
    const blue = (low * BAND_COLORS.low[2] + mid * BAND_COLORS.mid[2] + high * BAND_COLORS.high[2]) / total
    const amplitude = peak * Math.max(1, midY - 3)
    ctx.strokeStyle = `rgb(${red | 0}, ${green | 0}, ${blue | 0})`
    ctx.beginPath()
    ctx.moveTo(x + 0.5, midY - amplitude)
    ctx.lineTo(x + 0.5, midY + amplitude)
    ctx.stroke()
  }
}

function drawMain(
  canvas: HTMLCanvasElement,
  waveform: WaveformBands,
  grid: DeckGrid | null,
  pads: WaveformPad[],
  centerSeconds: number,
  windowSeconds: number,
): void {
  const prepared = prepareCanvas(canvas)
  if (!prepared) return
  const { ctx, width, height } = prepared
  const start = centerSeconds - windowSeconds / 2
  const end = centerSeconds + windowSeconds / 2
  const xAt = (seconds: number) => ((seconds - start) / windowSeconds) * width

  drawBands(ctx, waveform, width, height, start, end)

  // The grid is intentionally drawn without section/chord overlays: current
  // analysis does not justify presenting those labels as authoritative. Draw
  // beat markers over the envelope so they stay legible in loud passages.
  if (grid) {
    ctx.strokeStyle = 'rgba(148,163,184,.28)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const beat of grid.beatsSeconds) {
      if (beat < start || beat > end) continue
      const x = xAt(beat)
      ctx.moveTo(x + 0.5, height * 0.38)
      ctx.lineTo(x + 0.5, height * 0.62)
    }
    ctx.stroke()

    ctx.strokeStyle = 'rgba(241,245,249,.68)'
    ctx.beginPath()
    grid.downbeatsSeconds.forEach((downbeat, index) => {
      if (downbeat < start || downbeat > end) return
      const x = xAt(downbeat)
      ctx.moveTo(x + 0.5, 0)
      ctx.lineTo(x + 0.5, height)
      if (index % 4 === 0) {
        ctx.fillStyle = 'rgba(226,232,240,.62)'
        ctx.font = '9px "Segoe UI", sans-serif'
        ctx.fillText(String(index + 1), x + 3, 11)
      }
    })
    ctx.stroke()
  }

  for (const pad of pads) {
    if (pad.sourceSeconds < start || pad.sourceSeconds > end) continue
    const x = xAt(pad.sourceSeconds)
    ctx.fillStyle = 'rgba(250,204,21,.95)'
    ctx.beginPath()
    ctx.moveTo(x, height - 12)
    ctx.lineTo(x - 5, height)
    ctx.lineTo(x + 5, height)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#111827'
    ctx.font = 'bold 8px "Segoe UI", sans-serif'
    ctx.fillText(String(pad.slot), x - 2.5, height - 2)
  }
}

function drawOverview(
  canvas: HTMLCanvasElement,
  waveform: WaveformBands,
  pads: WaveformPad[],
): void {
  const prepared = prepareCanvas(canvas)
  if (!prepared) return
  const { ctx, width, height } = prepared
  drawBands(ctx, waveform, width, height, 0, waveform.durationSeconds)
  for (const pad of pads) {
    const x = (pad.sourceSeconds / (waveform.durationSeconds || 1)) * width
    ctx.fillStyle = 'rgba(250,204,21,.85)'
    ctx.fillRect(x - 0.5, 0, 1, height)
  }
}

export function Waveform({
  deckId,
  accent,
  waveform,
  waveformStatus,
  waveformFailureReason,
  grid,
  gridStatus,
  gridFailureReason,
  pads,
  duration,
  position,
  loaded,
  estimatedGrid,
  gridConfidence,
  onSeek,
}: Props) {
  const mainCanvasRef = useRef<HTMLCanvasElement>(null)
  const overviewCanvasRef = useRef<HTMLCanvasElement>(null)
  const mainWrapRef = useRef<HTMLDivElement>(null)
  const overviewWrapRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerX: number; target: number; windowSeconds: number } | null>(null)
  const seekTargetRef = useRef<number | null>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  const [zoomBars, setZoomBars] = useState<ZoomBars>(16)
  const [resizeVersion, setResizeVersion] = useState(0)

  const span = duration > 0 ? duration : waveform?.durationSeconds ?? 0
  const windowSeconds = waveformWindowSeconds(grid, zoomBars)
  const visualCenter = scrub ?? position

  useEffect(() => {
    if (!waveform || !mainCanvasRef.current || !overviewCanvasRef.current) return
    drawMain(mainCanvasRef.current, waveform, grid, pads, visualCenter, windowSeconds)
    drawOverview(overviewCanvasRef.current, waveform, pads)
  }, [waveform, grid, pads, visualCenter, windowSeconds, resizeVersion])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setResizeVersion((value) => value + 1))
    if (mainWrapRef.current) observer.observe(mainWrapRef.current)
    if (overviewWrapRef.current) observer.observe(overviewWrapRef.current)
    return () => observer.disconnect()
  }, [])

  const canPreviewSeconds = (seconds: number) => Number.isFinite(seconds) && seconds >= 0 && seconds <= span
  const mainSecondsAt = (clientX: number) => {
    const rect = mainWrapRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return position
    return position + ((clientX - rect.left) / rect.width - 0.5) * windowSeconds
  }
  const overviewSecondsAt = (clientX: number) => {
    const rect = overviewWrapRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return position
    return ((clientX - rect.left) / rect.width) * span
  }

  const confidenceLabel = gridConfidence !== null
    ? `信頼度 ${Math.round(gridConfidence * 100)}%`
    : null
  const overviewPercent = span > 0 ? (visualCenter / span) * 100 : 0
  const gridStateLabel = gridStatusLabel(gridStatus, gridFailureReason)

  const beginSeek = (event: React.PointerEvent<HTMLDivElement>, target: number) => {
    if (!loaded || span <= 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerX: event.clientX, target, windowSeconds }
    seekTargetRef.current = target
    setScrub(canPreviewSeconds(target) ? target : null)
  }
  const moveSeek = (event: React.PointerEvent<HTMLDivElement>, overview = false) => {
    if (!dragRef.current) return
    if (overview) {
      const target = overviewSecondsAt(event.clientX)
      seekTargetRef.current = target
      setScrub(canPreviewSeconds(target) ? target : null)
      return
    }
    const rect = mainWrapRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const delta = ((event.clientX - dragRef.current.pointerX) / rect.width) * dragRef.current.windowSeconds
    const target = dragRef.current.target + delta
    seekTargetRef.current = target
    setScrub(canPreviewSeconds(target) ? target : null)
  }
  const finishSeek = () => {
    const target = seekTargetRef.current
    if (target === null) return
    onSeek(target)
    dragRef.current = null
    seekTargetRef.current = null
    setScrub(null)
  }
  const cancelSeek = () => {
    dragRef.current = null
    seekTargetRef.current = null
    setScrub(null)
  }

  return (
    <div className="waveform" data-accent={accent}>
      <div className="waveform__toolbar">
        <span className="waveform__view-label">SCROLL</span>
        <div className="waveform__zoom" aria-label={`Deck ${deckId} waveform zoom`}>
          {ZOOM_BARS.map((bars) => (
            <button
              type="button"
              className={zoomBars === bars ? 'is-active' : ''}
              onClick={() => setZoomBars(bars)}
              key={bars}
            >
              {grid ? `${bars} BAR` : `${bars * 2}s`}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={mainWrapRef}
        className={`waveform__main ${loaded ? '' : 'is-empty'}`}
        role="slider"
        aria-label={`Deck ${deckId} scrolling waveform position`}
        aria-valuemin={0}
        aria-valuemax={Math.round(span)}
        aria-valuenow={Math.round(visualCenter)}
        tabIndex={loaded ? 0 : -1}
        onPointerDown={(event) => beginSeek(event, mainSecondsAt(event.clientX))}
        onPointerMove={(event) => moveSeek(event)}
        onPointerUp={finishSeek}
        onPointerCancel={cancelSeek}
        onKeyDown={(event) => {
          if (!loaded || span <= 0) return
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            onSeek(position + 5)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onSeek(position - 5)
          }
        }}
      >
        {waveform ? (
          <canvas ref={mainCanvasRef} className="waveform__canvas" />
        ) : (
          <div className="waveform__placeholder">
            {waveformPlaceholder(loaded, waveformStatus, waveformFailureReason)}
          </div>
        )}
        <span className="waveform__center-playhead" aria-hidden="true" />
        {scrub !== null && <span className="waveform__scrub-time">{formatTime(scrub)}</span>}
      </div>

      <div className="waveform__overview-row">
        <span className="waveform__view-label">OVERVIEW</span>
        <div
          ref={overviewWrapRef}
          className={`waveform__overview ${loaded ? '' : 'is-empty'}`}
          role="slider"
          aria-label={`Deck ${deckId} track overview position`}
          aria-valuemin={0}
          aria-valuemax={Math.round(span)}
          aria-valuenow={Math.round(visualCenter)}
          tabIndex={loaded ? 0 : -1}
          onPointerDown={(event) => beginSeek(event, overviewSecondsAt(event.clientX))}
          onPointerMove={(event) => moveSeek(event, true)}
          onPointerUp={finishSeek}
          onPointerCancel={cancelSeek}
          onKeyDown={(event) => {
            if (!loaded || span <= 0) return
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              onSeek(position + 5)
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault()
              onSeek(position - 5)
            }
          }}
        >
          {waveform && <canvas ref={overviewCanvasRef} className="waveform__canvas" />}
          <span className="waveform__overview-playhead" style={{ left: `${overviewPercent}%` }} aria-hidden="true" />
        </div>
      </div>

      <div className="waveform__legend">
        <span className="waveform__key waveform__key--low">LOW</span>
        <span className="waveform__key waveform__key--mid">MID</span>
        <span className="waveform__key waveform__key--high">HI</span>
        {grid && estimatedGrid && (
          <span className="waveform__badge waveform__badge--estimate" title="ビートグリッドは推定値です。人間の確認前は確定値ではありません。">
            推定グリッド
          </span>
        )}
        {grid && confidenceLabel && <span className="waveform__badge">{confidenceLabel}</span>}
        {gridStateLabel && (
          <span className="waveform__badge" title={gridFailureReason ?? undefined}>
            {gridStateLabel}
          </span>
        )}
      </div>
    </div>
  )
}
