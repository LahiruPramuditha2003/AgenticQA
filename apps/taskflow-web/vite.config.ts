import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5174 so TaskFlow and demo-web can run side by side during benchmarking.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
})
