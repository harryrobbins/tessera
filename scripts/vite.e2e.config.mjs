// Dev-server config for the tour e2e: the project config (whose watcher is
// already an allow-list over src/, public/ and index.html — several vite
// servers run at once during the verification scripts) with the
// type-checker's browser overlay off — it sits above the page and would
// intercept the clicks the tour is being tested with. HMR is off too: an edit
// landing mid-run (other agents, an editor) would reload the page and reset
// the tour halfway through the walk.
import checker from 'vite-plugin-checker';
import base from '../vite.config.ts';

export default {
  ...base,
  plugins: [checker({ typescript: true, overlay: false })],
  server: {
    ...base.server,
    hmr: false,
    watch: null,
  },
};
