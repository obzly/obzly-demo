// Fills in the app's sign-in and MFA forms the way a password manager would,
// and adds a short note above each, so a visitor only has to click through.
// Plain DOM, outside React: it watches for the forms and types into them.
import { DEMO_USER } from './world';

const SIGN_IN_NOTE = 'Demo account filled in for you. Any password works.';
const CODE_NOTE = 'A sample code is filled in. Any 6 digits work.';

const css = `
.obzly-demo-hint{display:flex;gap:6px;align-items:flex-start;margin:0 0 12px;padding:7px 10px;border-radius:6px;
  background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;font:400 12px/1.45 Jost,system-ui,sans-serif}
.dark .obzly-demo-hint,[data-theme="dark"] .obzly-demo-hint{background:#064e3b;color:#d1fae5;border-color:#047857}
`;

/** Random characters from an unambiguous alphabet. */
function randomFrom(alphabet: string, length: number): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const randomPassword = () =>
  `${randomFrom('ABCDEFGHJKLMNPQRSTUVWXYZ', 1)}${randomFrom('abcdefghijkmnpqrstuvwxyz23456789', 11)}-${randomFrom('23456789', 2)}`;
export const randomCode = () => randomFrom('0123456789', 6);

/** Sets a React-controlled input's value so its onChange runs. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A note above the field's label (the form's own markup: label div, then input). */
function addNote(input: HTMLInputElement, text: string) {
  const field = input.closest('.ant-input-affix-wrapper') ?? input;
  const label = field.previousElementSibling;
  const anchor = label && !label.classList.contains('obzly-demo-hint') ? label : field;
  if (anchor.previousElementSibling?.classList.contains('obzly-demo-hint')) return;
  const note = document.createElement('div');
  note.className = 'obzly-demo-hint';
  note.setAttribute('role', 'note');
  note.textContent = text;
  anchor.parentElement?.insertBefore(note, anchor);
}

// Each input is filled once: if the visitor clears it, it stays cleared.
const filled = new WeakSet<HTMLInputElement>();

function fill(input: HTMLInputElement | null, value: string, note?: string) {
  if (!input || filled.has(input)) return;
  filled.add(input);
  if (note) addNote(input, note);
  if (!input.value) typeInto(input, value);
}

/** Signed out: the app shows its sign-in page (its token key in localStorage). */
function signedOut(): boolean {
  try {
    return !localStorage.getItem('obzly_user_token');
  } catch {
    return true;
  }
}

function scan() {
  // Only the sign-in page; the profile's MFA settings use the same code field.
  if (!signedOut()) return;
  const email = document.querySelector<HTMLInputElement>('input[autocomplete="username"]');
  if (email) {
    // The sign-in form: email, then its password field.
    const password = email.parentElement?.querySelector<HTMLInputElement>('input[type="password"]');
    fill(email, DEMO_USER.email, SIGN_IN_NOTE);
    fill(password ?? null, randomPassword());
  }
  // The MFA step's "6-digit code" field.
  fill(
    document.querySelector<HTMLInputElement>('input[inputmode="numeric"][maxlength="6"]'),
    randomCode(),
    CODE_NOTE,
  );
}

export function prefillSignIn() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  new MutationObserver(scan).observe(document.body, {
    childList: true,
    subtree: true,
  });
  scan();
}
