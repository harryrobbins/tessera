import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';

export default defineConfig({
  // Vite strips types without checking them; this runs tsc alongside and surfaces
  // type errors as a browser overlay. Cheap static analysis, no lint ceremony.
  plugins: [checker({ typescript: true })],
  server: {
    port: 5180,
    // WSL2: source-only watching. node_modules is ignored by default; never poll on the Linux fs.
    watch: { ignored: ['**/node_modules/**', '**/bench-results/**', '**/.git/**'] },
  },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
