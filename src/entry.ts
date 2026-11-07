// The demo build's entry, used in place of main.tsx (vite.demo.config.ts
// swaps it in index.html). The demo installs first, so every API call the app
// makes is answered in the browser, then the unchanged app starts.
import './install';

// Loaded only once the demo is installed (a static import could be reordered).
void import('../main.tsx');
