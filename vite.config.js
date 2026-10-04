import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createDeepSeekProxy } from './server/deepseek-proxy.mjs'

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    name: 'local-deepseek-proxy',
    configureServer(server) {
      const env = loadEnv(mode, process.cwd(), '')
      server.middlewares.use(createDeepSeekProxy({ env }))
    },
    configurePreviewServer(server) {
      const env = loadEnv(mode, process.cwd(), '')
      server.middlewares.use(createDeepSeekProxy({ env }))
    }
  }],
  server: {
    port: 5173,
    host: '127.0.0.1'
  }
}))
