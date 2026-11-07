/**
 * Accelerator matching for platforms where the shell installs no menu bar.
 *
 * On macOS the New Window accelerator is bound to a real menu item and Electron handles it. On
 * Windows and Linux the shell deliberately ships no menu bar (the app UI is a web page, a native
 * menu would look wrong), so the key combination is matched here against `before-input-event`.
 *
 * Electron-free so it can be unit tested.
 */

/** @typedef {{ ctrl: boolean, meta: boolean, shift: boolean, alt: boolean, key: string }} Chord */

/** Names that are modifiers, never the key being bound. */
const MODIFIER_NAMES = new Set([
  'cmdorctrl',
  'commandorcontrol',
  'cmd',
  'command',
  'super',
  'meta',
  'ctrl',
  'control',
  'shift',
  'alt',
  'option',
]);

/**
 * Parse an Electron accelerator string such as `CmdOrCtrl+Shift+N`.
 *
 * @param {string} accelerator
 * @param {string} [platform] defaults to the running platform; `CmdOrCtrl` resolves per platform
 * @returns {Chord | null} null when the string has no key or an unknown modifier
 */
export function parseAccelerator(accelerator, platform = process.platform) {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return null;
  const parts = accelerator.split('+').map((part) => part.trim());
  // A blank segment means a stray or trailing `+`, e.g. "CmdOrCtrl+": no key to bind.
  if (parts.length < 2 || parts.some((part) => part === '')) return null;

  const key = parts.pop().toLowerCase();
  if (MODIFIER_NAMES.has(key)) return null;
  const chord = { ctrl: false, meta: false, shift: false, alt: false, key };

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'cmdorctrl':
      case 'commandorcontrol':
        if (platform === 'darwin') chord.meta = true;
        else chord.ctrl = true;
        break;
      case 'cmd':
      case 'command':
      case 'super':
      case 'meta':
        chord.meta = true;
        break;
      case 'ctrl':
      case 'control':
        chord.ctrl = true;
        break;
      case 'shift':
        chord.shift = true;
        break;
      case 'alt':
      case 'option':
        chord.alt = true;
        break;
      default:
        return null;
    }
  }
  return chord;
}

/**
 * True when an Electron `before-input-event` input matches the chord exactly — no extra
 * modifiers, so Ctrl+Shift+N does not trigger a plain Ctrl+N binding.
 *
 * @param {Chord | null} chord
 * @param {{ type: string, key: string, control: boolean, meta: boolean, shift: boolean, alt: boolean }} input
 */
export function matchesChord(chord, input) {
  if (!chord || !input || input.type !== 'keyDown') return false;
  return (
    String(input.key).toLowerCase() === chord.key &&
    Boolean(input.control) === chord.ctrl &&
    Boolean(input.meta) === chord.meta &&
    Boolean(input.shift) === chord.shift &&
    Boolean(input.alt) === chord.alt
  );
}
