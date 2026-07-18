#!/usr/bin/env node
/**
 * Non-live demo smoke check (Order 7 §8 / §5.8 完了条件).
 *
 * Confirms the pieces a 3-minute demo depends on, WITHOUT any live model quota
 * or API key:
 *   1. data/catalog.json is present and well-formed.
 *   2. GET  /api/agent/capability answers with the capability descriptor.
 *   3. POST /api/agent/decide (deterministic route) returns outcome:"decided" —
 *      exercising the real orchestrator + deterministic engine + validation.
 *
 * Port handling (Order 7 §8 finding 10): a *fixed* port would let a pre-existing
 * server on that port pass the checks while OUR backend never bound it. Instead
 * we let the OS assign a free loopback port, spawn a DEDICATED backend child on
 * it, and only run the endpoint checks after confirming THAT child stayed alive
 * long enough to become ready — a bind failure (or any early exit/error) aborts
 * the run instead of silently validating someone else's server. The child is
 * torn down and its exit awaited in `finally`.
 *
 * Uses only Node built-ins.
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createServer } from 'node:net'
import process from 'node:process'

const isWindows = process.platform === 'win32'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}
function ok(message) {
  console.log(`✓ ${message}`)
}

function summary(track) {
  return {
    trackId: track.trackId,
    title: track.title,
    artist: track.artist,
    genre: track.genre,
    mood: Array.isArray(track.mood) ? track.mood : [],
    bpm: track.bpm,
    camelot: track.camelot,
    energy: track.energy,
    hasBeatGrid: Number.isInteger(track.beatCount) && track.beatCount > 0,
    hasSectionCues: (track.sectionSummary?.length ?? 0) > 0,
  }
}

/**
 * Asks the OS for a free loopback TCP port by binding port 0, reading the
 * assigned port, then releasing it. There is a tiny window between release and
 * the backend binding it; a collision there surfaces as the child failing to
 * bind, which {@link waitForCapability} detects (it never validates a server we
 * did not start).
 */
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        srv.close(() => reject(new Error('could not determine a free port')))
        return
      }
      const { port } = address
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

async function waitForCapability(base, backend, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const readyMarker = `[vibraxis-agent] listening on ${base}`
  while (Date.now() < deadline) {
    // Abort the moment the dedicated child dies, so a 200 from an unrelated
    // server can never be mistaken for OUR backend being ready.
    if (backend.error) throw new Error(`backend failed to start: ${backend.error.message}`)
    if (backend.exit !== null) {
      throw new Error(`backend exited before readiness (${backend.exit.signal ?? backend.exit.code}).`)
    }
    // A response is accepted only after our dedicated child emitted its exact
    // listen marker. This proves endpoint identity even if another process was
    // racing for the same port.
    if (!backend.log.includes(readyMarker)) {
      await new Promise((r) => setTimeout(r, 50))
      continue
    }
    try {
      const res = await fetch(`${base}/api/agent/capability`)
      if (res.ok) {
        const value = await res.json()
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (backend.error || backend.exit !== null) {
          throw new Error('dedicated backend exited while confirming readiness.')
        }
        return value
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return null
}

async function runChecks(base, backend) {
  // 1. Catalog ----------------------------------------------------------------
  const catalogRaw = await readFile(resolve(repoRoot, 'data', 'catalog.json'), 'utf8')
  const catalog = JSON.parse(catalogRaw)
  if (catalog.catalogVersion !== 2 || !Array.isArray(catalog.tracks) || catalog.tracks.length < 2) {
    throw new Error('catalog.json must contain at least two tracks for a mix demo.')
  }
  for (const t of catalog.tracks) {
    if (typeof t.trackId !== 'string' || typeof t.bpm !== 'number' || typeof t.camelot !== 'string'
      || !Number.isInteger(t.beatCount) || t.beatCount < 0) {
      throw new Error(`catalog track "${t.trackId}" is missing required fields.`)
    }
  }
  ok(`catalog.json parsed (${catalog.tracks.length} tracks)`)

  // 2. Start backend + capability --------------------------------------------
  const capability = await waitForCapability(base, backend, 15_000)
  if (capability === null) throw new Error('capability endpoint did not respond within 15s.')
  if (!Array.isArray(capability.routes) || !capability.routes.includes('deterministic')) {
    throw new Error('capability did not advertise the deterministic route.')
  }
  ok(`capability responded (routes: ${capability.routes.join(', ')}; gpt56=${capability.availability?.gpt56}, codexLocal=${capability.availability?.codexLocal})`)

  // 3. Deterministic decide ---------------------------------------------------
  const [current, ...rest] = catalog.tracks
  const context = {
    activeDeckId: 'A',
    inactiveDeckId: 'B',
    currentTrack: summary(current),
    candidates: rest.map(summary),
    recentlyPlayedTrackIds: [],
    limits: { minPlaybackRate: 0.5, maxPlaybackRate: 1.5, allowedCrossfadeBars: [4, 8, 16] },
  }
  const intent = {
    energyDirection: 'maintain',
    targetEnergy: null,
    preferredGenres: [],
    avoidedGenres: [],
    preferredMoods: [],
    avoidedMoods: [],
    tempoDirection: 'any',
    harmonicPriority: 'ignore',
    transitionUrgency: 'normal',
    requestedTrackId: null,
    excludedTrackIds: [],
    rationale: 'demo smoke deterministic decision',
    confidence: 0.5,
  }
  const decideRes = await fetch(`${base}/api/agent/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ route: 'deterministic', context, intent }),
  })
  if (!decideRes.ok) throw new Error(`decide returned HTTP ${decideRes.status}`)
  const decided = await decideRes.json()
  if (decided.outcome !== 'decided') {
    throw new Error(`deterministic decide expected outcome "decided", got "${decided.outcome}" (${decided.failure?.code ?? 'n/a'})`)
  }
  if (decided.decisionProvider !== 'deterministic' || decided.usedDeterministicFallback !== false) {
    throw new Error('deterministic decide provenance was not the deterministic engine.')
  }
  ok(`deterministic decide -> next=${decided.decision.nextTrackId} deck=${decided.decision.targetDeckId} xfade=${decided.decision.crossfadeBars}bars conf=${decided.decision.confidence}`)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function windowsTreePids(rootPid) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect Windows process tree for pid ${rootPid}.`)
  }
  const parsed = JSON.parse(result.stdout || '[]')
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const found = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (found.has(Number(row.ParentProcessId)) && !found.has(Number(row.ProcessId))) {
        found.add(Number(row.ProcessId))
        changed = true
      }
    }
  }
  return [...found]
}

/** Resolves only after the backend child tree/group is confirmed gone. */
async function stopBackend(child) {
  if (child.pid === undefined) return
  if (!isWindows && !processGroupAlive(child.pid)) return
  const pid = child.pid
  if (isWindows) {
    const treePids = windowsTreePids(pid)
    const killed = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    if ((killed.error || killed.status !== 0) && treePids.some(pidAlive)) {
      throw new Error('taskkill failed for the dedicated backend process tree.')
    }
    for (let elapsed = 0; elapsed < 5000; elapsed += 100) {
      if (!treePids.some(pidAlive)) return
      await delay(100)
    }
    throw new Error('dedicated backend process tree still has live PIDs after taskkill.')
  }

  try { process.kill(-pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  await delay(2000)
  if (processGroupAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* checked below */ }
  }
  for (let elapsed = 0; elapsed < 3000; elapsed += 100) {
    if (!processGroupAlive(pid)) return
    await delay(100)
  }
  throw new Error(`dedicated backend process group ${pid} is still alive after SIGKILL.`)
}

async function main() {
  const port = process.env.SMOKE_AGENT_PORT ?? String(await reserveFreePort())
  const base = `http://127.0.0.1:${port}`

  const child = spawn(process.execPath, ['backend/src/server.ts'], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_PORT: port },
    shell: false,
    // Own process group on POSIX so the whole subtree can be reaped.
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Track lifecycle so the readiness loop can fail fast on spawn error/early exit.
  const backend = { error: null, exit: null, log: '' }
  child.on('error', (e) => { backend.error = e })
  child.on('exit', (code, signal) => { backend.exit = { code, signal } })
  child.stdout?.on('data', (d) => { backend.log += d })
  child.stderr?.on('data', (d) => { backend.log += d })

  let checksPassed = false
  try {
    await runChecks(base, backend)
    if (process.exitCode) throw new Error('one or more checks failed')
    checksPassed = true
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    if (backend.log.trim().length > 0) console.error(`\n--- backend output ---\n${backend.log.trim()}`)
    process.exitCode = 1
  } finally {
    try {
      await stopBackend(child)
    } catch (error) {
      fail(error instanceof Error ? `backend cleanup failed: ${error.message}` : 'backend cleanup failed')
    }
  }
  if (checksPassed && !process.exitCode) console.log('\nDEMO SMOKE: PASS')
  else console.error('\nDEMO SMOKE: FAIL')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
  console.error('\nDEMO SMOKE: FAIL')
  process.exit(1)
})
