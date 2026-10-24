import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    // only used with `npm run dev:local` (scripts/local-backend.mjs)
    proxy: { '/rest/v1': 'http://localhost:54321' },
  },
});
