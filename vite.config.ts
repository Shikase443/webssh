import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    // Avoid esbuild's re-minification bug in xterm 6 requestMode (upstream issue #5800).
    minify: 'terser',
    rollupOptions: { output: { manualChunks(id) {
      if (id.includes('@xterm')) return 'terminal';
      if (id.includes('node_modules')) return 'vendor';
    } } }
  }
});
