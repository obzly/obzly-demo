// A small floating note in demo builds: what this is, a reset, and the way
// to install the real thing. Plain DOM, outside React, so it never touches
// the app's layout.
import { hasChanges } from './store';

const INSTALL_URL = 'https://obzly.com/docs/getting-started/quick-install/';
const COLLAPSED_KEY = 'obzly_demo_banner_collapsed';

const css = `
.obzly-demo-note{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:calc(100vw - 32px);
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px 8px 14px;border-radius:999px;
  background:#0f172a;color:#e2e8f0;font:500 13px/1.3 Jost,system-ui,sans-serif;
  box-shadow:0 6px 24px rgba(15,23,42,.35);border:1px solid rgba(148,163,184,.25)}
.obzly-demo-note b{color:#34d399;font-weight:600}
.obzly-demo-note a,.obzly-demo-note button{font:inherit;cursor:pointer;border-radius:999px;padding:4px 10px;
  border:1px solid rgba(148,163,184,.35);background:transparent;color:#e2e8f0;text-decoration:none;white-space:nowrap}
.obzly-demo-note a.primary{background:#059669;border-color:#059669;color:#fff}
.obzly-demo-note a:hover,.obzly-demo-note button:hover{border-color:#34d399}
.obzly-demo-note .x{border:none;padding:2px 6px;color:#94a3b8}
.obzly-demo-chip{position:fixed;left:16px;bottom:16px;z-index:2147483000;padding:6px 12px;border-radius:999px;
  background:#0f172a;color:#34d399;font:600 12px/1 Jost,system-ui,sans-serif;border:1px solid rgba(148,163,184,.25);cursor:pointer}
@media (max-width:640px){.obzly-demo-note{border-radius:14px}.obzly-demo-note .why{display:none}}
`;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    if (collapsed) localStorage.setItem(COLLAPSED_KEY, '1');
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    /* per-viewer nicety only */
  }
}

export function mountDemoBanner() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const host = document.createElement('div');
  document.body.appendChild(host);

  const render = () => {
    host.replaceChildren();
    if (readCollapsed()) {
      const chip = document.createElement('button');
      chip.className = 'obzly-demo-chip';
      chip.textContent = 'Live demo';
      chip.title = 'Show demo options';
      chip.onclick = () => {
        writeCollapsed(false);
        render();
      };
      host.appendChild(chip);
      return;
    }
    const note = document.createElement('div');
    note.className = 'obzly-demo-note';
    note.setAttribute('role', 'note');
    note.innerHTML =
      '<span><b>Live demo</b> <span class="why">· sample data · your changes stay in this browser</span></span>';
    const reset = document.createElement('button');
    reset.textContent = 'Reset demo';
    reset.title = hasChanges() ? 'Undo everything you changed' : 'Nothing changed yet';
    reset.onclick = async () => {
      const { restartDemo } = await import('./install');
      restartDemo();
    };
    const install = document.createElement('a');
    install.className = 'primary';
    install.href = INSTALL_URL;
    install.target = '_blank';
    install.rel = 'noopener';
    install.textContent = 'Install Obzly';
    const close = document.createElement('button');
    close.className = 'x';
    close.setAttribute('aria-label', 'Minimize');
    close.textContent = '✕';
    close.onclick = () => {
      writeCollapsed(true);
      render();
    };
    note.append(reset, install, close);
    host.appendChild(note);
  };
  render();
}
