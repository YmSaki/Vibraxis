import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Connect, Plugin } from 'vite'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const catalogPath = resolve(repositoryRoot, 'data', 'catalog.json')
const tracksRoot = resolve(repositoryRoot, 'data', 'sample')

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

export default defineConfig({
  plugins: [react(), localMusicApi()],
  server: { port: 5173 },
})
