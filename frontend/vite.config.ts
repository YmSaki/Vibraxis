import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Connect, Plugin } from 'vite'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const catalogPath = resolve(repositoryRoot, 'data', 'catalog.json')
const tracksRoot = resolve(repositoryRoot, 'data', 'sample')
const analysisRoot = resolve(repositoryRoot, 'data', 'analysis')

function localMusicApi(): Plugin {
  const middleware: Connect.NextHandleFunction = async (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://localhost')

    if (url.pathname === '/api/catalog') {
      try {
        const catalog = await readFile(catalogPath, 'utf8')
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        response.end(catalog)
      } catch {
        response.statusCode = 500
        response.end('Catalog is unavailable. Run the analyze-tool catalog task.')
      }
      return
    }

    if (url.pathname.startsWith('/api/analysis/')) {
      const trackId = decodeURIComponent(url.pathname.slice('/api/analysis/'.length))
      try {
        // The trackId must exist in the catalog; the file path is derived from
        // it, never taken from the request, so arbitrary paths are impossible.
        const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
          tracks?: Array<{ trackId?: string }>
        }
        const known =
          trackId.length > 0 &&
          Array.isArray(catalog.tracks) &&
          catalog.tracks.some((track) => track.trackId === trackId)
        const path = resolve(analysisRoot, `${trackId}.json`)
        if (!known || !path.startsWith(`${analysisRoot}${sep}`) || !existsSync(path)) {
          response.statusCode = 404
          response.end('Analysis not found')
          return
        }
        response.statusCode = 200
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.setHeader('Cache-Control', 'private, max-age=3600')
        createReadStream(path).pipe(response)
      } catch {
        response.statusCode = 500
        response.end('Analysis is unavailable.')
      }
      return
    }

    if (url.pathname.startsWith('/tracks/')) {
      const filename = decodeURIComponent(url.pathname.slice('/tracks/'.length))
      const path = resolve(tracksRoot, filename)
      if (!filename || !path.startsWith(`${tracksRoot}${sep}`) || !existsSync(path)) {
        response.statusCode = 404
        response.end('Track not found')
        return
      }
      const contentTypes: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.flac': 'audio/flac',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
      }
      response.statusCode = 200
      response.setHeader('Content-Type', contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream')
      response.setHeader('Cache-Control', 'private, max-age=3600')
      createReadStream(path).pipe(response)
      return
    }

    next()
  }

  return {
    name: 'vibraxis-local-music-api',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

// The DJ Agent backend (backend/src/server.ts) listens loopback-only on
// AGENT_PORT (default 8787). Proxy just the agent routes to it; catalog/track
// routes stay served by the local middleware above.
const agentTarget = `http://127.0.0.1:${process.env.AGENT_PORT ?? '8787'}`

export default defineConfig({
  plugins: [react(), localMusicApi()],
  server: {
    port: 5173,
    proxy: {
      '/api/agent': { target: agentTarget, changeOrigin: false },
    },
  },
})
