/**
 * The tray menu's only behaviour.
 *
 * Every row sends one command name and nothing else; the shell decides what each means and
 * ignores anything not on its list. As with the window, there is no path from here to a
 * verdict — "Neu prüfen" asks for another scan, not for another answer.
 */

/** The commands this page may send. Anything else is a bug in the markup. */
export const COMMANDS = ['show', 'recheck', 'quit'];

/**
 * @param {Document} document
 * @param {{ipc?: {postMessage: (message: string) => void}}} host
 */
export function connectMenu(document, host) {
  if (typeof host?.ipc?.postMessage !== 'function') return false;

  for (const button of document.querySelectorAll('[data-command]')) {
    const command = button.dataset.command;
    if (!COMMANDS.includes(command)) continue;

    button.addEventListener('click', () => {
      host.ipc.postMessage(JSON.stringify({ command }));
    });
  }

  // A menu that outlives the click somewhere else is a menu that has to be dismissed twice.
  window.addEventListener('blur', () => {
    host.ipc.postMessage(JSON.stringify({ command: 'dismiss' }));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      host.ipc.postMessage(JSON.stringify({ command: 'dismiss' }));
    }
  });

  return true;
}

if (typeof document !== 'undefined' && document.getElementById('menu') !== null) {
  connectMenu(document, globalThis.window);
}
