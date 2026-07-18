#!/usr/bin/env node
/**
 * One-command local dev launcher (Order 7 §6).
 *
 * Starts the DJ Agent backend (loopback HTTP on AGENT_PORT, default 8787) and
 * the Vite frontend (which proxies /api/agent to that backend) together, streams
 * both logs with prefixes, and tears BOTH process trees down cleanly on Ctrl-C
 * or when either process exits. Uses only Node built-ins — no new dependency.
 *
 * Process handling (Order 7 §6 finding 9):
 *   - We do not wrap children in a shell. A `sh -c "npm …"` wrapper makes the
 *     real npm/vite/node a *grandchild*, and a SIGTERM to the shell leaves that
 *     grandchild orphaned. Instead we spawn the backend and Vite Node entry
 *     points directly, so the tracked child is the real service process.
 *   - On POSIX each child leads its own process group (`detached`), so a single
 *     `kill(-pid, signal)` reaps the whole subtree; SIGTERM then SIGKILL.
 *   - On Windows `taskkill /T /F` reaps the tree (no POSIX groups exist).
 *   - Shutdown AWAITS every child's real exit before the launcher itself exits.
 *
 * Usage: npm run dev   (from the repository root)
 */

import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

const isWindows = process.platform === 'win32'

const AGENT_PORT = process.env.AGENT_PORT ?? '8787'

/** @type {Array<{ name: string, child: import('node:child_process').ChildProcess }>} */
const procs = []
let shuttingDown = false

function log(name, line) {
  for (const part of String(line).split(/\r?\n/)) {
    if (part.length > 0) process.stdout.write(`[${name}] ${part}\n`)
  }
}

function start(name, command, args, env, cwd = process.cwd()) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    // A shell wrapper is deliberately avoided (see file header). On POSIX,
    // detached puts every child in its own process group. On POSIX this lets us
    // signal the group; on Windows it also prevents Ctrl-C from reaching npm's
    // cmd.exe grandchildren and opening an interactive "Terminate batch job?"
    // prompt before taskkill /T performs the explicit tree shutdown.
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (data) => log(name, data))
  child.stderr?.on('data', (data) => log(name, data))
  child.on('error', (error) => {
    log(name, `failed to start: ${error.message}`)
    void shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    log(name, `exited (${signal ?? code}). Shutting the other process down.`)
    void shutdown(typeof code === 'number' && code !== 0 ? code : 1)
  })
  procs.push({ name, child })
  return child
}

/** Sends one signal to a child's whole process tree, per platform. */
function signalTree(child, signal) {
  if (child.pid === undefined) return
  if (!isWindows) {
    // Negative pid => the child's process group (it is the group leader because
    // it was spawned detached), so npm and its vite/node grandchildren are hit.
    try {
      process.kill(-child.pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // Already gone.
      }
    }
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Resolves only after the child tree/group is confirmed gone. */
async function stopChild(name, child) {
  if (child.pid === undefined) return
  if (!isWindows && !processGroupAlive(child.pid)) return
  log('dev', `stopping ${name}…`)
  const pid = child.pid
  if (isWindows) {
    const treePids = windowsTreePids(pid)
    const killed = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    if ((killed.error || killed.status !== 0) && treePids.some(pidAlive)) {
      throw new Error(`${name} taskkill failed for process tree ${pid}.`)
    }
    for (let elapsed = 0; elapsed < 5000; elapsed += 100) {
      if (!treePids.some(pidAlive)) return
      await delay(100)
    }
    throw new Error(`${name} process tree still has live PIDs after taskkill.`)
  }
  signalTree(child, 'SIGTERM')

  // Do not treat the npm group leader's exit as proof that vite/node children
  // exited. Always inspect the process group and retain the SIGKILL escalation.
  await delay(2000)
  if (processGroupAlive(pid)) signalTree(child, 'SIGKILL')
  for (let elapsed = 0; elapsed < 3000; elapsed += 100) {
    if (!processGroupAlive(pid)) return
    await delay(100)
  }
  throw new Error(`${name} process group ${pid} is still alive after SIGKILL.`)
}

async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  let exitCode = code
  try {
    await Promise.all(procs.map(({ name, child }) => stopChild(name, child)))
  } catch (error) {
    log('dev', error instanceof Error ? `cleanup failed: ${error.message}` : 'cleanup failed')
    exitCode = 1
  }
  if (exitCode === 0) log('dev', 'all child process trees stopped cleanly')
  process.exit(exitCode)
}

process.on('SIGINT', () => {
  log('dev', 'received SIGINT')
  void shutdown(0)
})
process.on('SIGTERM', () => void shutdown(0))

log('dev', `starting backend (AGENT_PORT=${AGENT_PORT}) and frontend…`)
start('backend', process.execPath, ['backend/src/server.ts'], { AGENT_PORT })
start(
  'frontend',
  process.execPath,
  [resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js')],
  { AGENT_PORT },
  resolve(process.cwd(), 'frontend'),
)
