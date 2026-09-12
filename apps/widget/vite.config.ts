import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/locogi-widget.ts',
      name: 'LocogiWidget',
      fileName: 'locogi-widget',
      formats: ['iife'],
    },
    outDir: 'dist',
    minify: 'terser',
    cssCodeSplit: false, // inline CSS into JS
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
