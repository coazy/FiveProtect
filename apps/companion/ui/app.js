/**
 * The companion window.
 *
 * Design document 12.1: four states and no more. The shell owns the state; this file turns
 * it into pixels and does nothing else. There is deliberately no path from anything the
 * user does here to an allow or a deny — the window cannot make the check pass, because
 * passing is not something a client decides (ADR 0004).
 */

/** The four states, in the order a connect walks through them. */
export const STATES = ['idle', 'checking', 'ready', 'blocked'];

const HEADINGS = {
  idle: { name: 'Nicht verbunden', note: 'Warte auf einen Server.' },
  checking: {
    name: 'Prüfung läuft',
    note: 'Dein System wird geprüft. Das dauert wenige Sekunden.',
  },
  // Not "everything is fine": the companion is never told how the server judged the
  // snapshot (ADR 0004), so the window can only say what it knows — that the check ran and
  // the report was accepted.
  ready: { name: 'Bereit', note: 'Deine Systemprüfung wurde an den Server übermittelt.' },
  blocked: { name: 'Blockiert', note: 'Der Server hat die Verbindung abgelehnt.' },
};

/**
 * Wording for each requirement, in the order the window shows them.
 *
 * Short labels on the left, a state word on the right. The wording is chosen so a player
 * can match it against what they see in Windows — "Speicherintegrität" is what the setting
 * is actually called, not "HVCI".
 */
const REQUIREMENT_LABELS = {
  secure_boot_enabled: 'Secure Boot',
  tpm_attestation_valid: 'TPM 2.0',
  hvci_enabled: 'Speicherintegrität',
  driver_blocklist_enabled: 'Treiber-Sperrliste',
  iommu_enabled: 'Kernel-DMA-Schutz',
  test_signing_disabled: 'Testsignatur',
  kernel_debugging_disabled: 'Kernel-Debugger',
  vulnerable_drivers_absent: 'Treiberprüfung',
  game_process_present: 'FiveM erkannt',
  network_origin_matches: 'Netzwerkprüfung',
  companion_attested: 'Systemprüfung',
};

const STATUS_WORDS = {
  pass: 'aktiv',
  warn: 'empfohlen',
  fail: 'inaktiv',
  unknown: 'unklar',
  skipped: 'nicht nötig',
  pending: 'wird geprüft',
};

/**
 * Requirements whose state word is about presence rather than a switch.
 *
 * "Systemprüfung: aktiv" reads wrong; "bestanden" is what a player expects. A small table
 * beats a general rule that would have to guess.
 */
const PRESENCE_WORDS = {
  companion_attested: { pass: 'bestanden', fail: 'nicht bestanden' },
  game_process_present: { pass: 'gefunden', fail: 'nicht gefunden' },
  network_origin_matches: { pass: 'in Ordnung', fail: 'abweichend' },
  vulnerable_drivers_absent: { pass: 'sauber', fail: 'auffällig' },
  test_signing_disabled: { pass: 'aus', fail: 'an' },
  kernel_debugging_disabled: { pass: 'aus', fail: 'an' },
};

function statusWord(requirement, status) {
  return PRESENCE_WORDS[requirement]?.[status] ?? STATUS_WORDS[status] ?? status;
}

/** Requirements the window never lists, because a player cannot act on them. */
const HIDDEN = new Set(['network_origin_matches']);

/**
 * Turns a view model into the window.
 *
 * @param {Document} document
 * @param {{
 *   state: 'idle'|'checking'|'ready'|'blocked',
 *   requirements?: {requirement: string, status: string, detail?: string}[],
 *   remediation?: string,
 *   serverName?: string,
 *   version?: string,
 *   protocolVersion?: number,
 * }} view
 */
export function render(document, view) {
  const window_ = document.getElementById('window');
  window_.dataset.state = view.state;

  const heading = HEADINGS[view.state];
  document.getElementById('state-name').textContent = heading.name;
  document.getElementById('state-note').textContent = heading.note;

  document.getElementById('progress').hidden = view.state !== 'checking';

  renderWaiting(document, view);
  renderChecks(document, view);
  renderCallout(document, view);
  renderActions(document, view);

  document.getElementById('server').textContent = view.serverName ?? '';
  document.getElementById('version').textContent =
    `Version ${view.version ?? '0.1.0'} · Protokoll ${view.protocolVersion ?? 1}`;
}

/**
 * The idle screen.
 *
 * Two different waits, and the difference matters to the player: without FiveM running there
 * is nothing FiveProtect could be asked about, and with it running the companion is simply
 * waiting for a server to ask. Saying which one it is turns "nothing is happening" into
 * "nothing is supposed to be happening yet".
 */
function renderWaiting(document, view) {
  const section = document.getElementById('waiting');
  const text = document.getElementById('waiting-text');

  if (view.state !== 'idle') {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  section.dataset.found = String(view.gamePresent === true);
  text.textContent =
    view.gamePresent === true
      ? 'FiveM läuft. Warte auf einen Server …'
      : 'Warte auf FiveM. Starte das Spiel, wenn du verbinden willst.';
}

function renderChecks(document, view) {
  const list = document.getElementById('checks');
  list.replaceChildren();

  const requirements = (view.requirements ?? []).filter(
    (entry) => !HIDDEN.has(entry.requirement) && entry.status !== 'skipped',
  );

  for (const entry of requirements) {
    const row = document.createElement('li');

    const label = document.createElement('span');
    label.className = 'check-label';
    label.textContent = REQUIREMENT_LABELS[entry.requirement] ?? entry.requirement;

    const value = document.createElement('span');
    value.className = 'check-value';
    value.dataset.status = entry.status;
    value.textContent = statusWord(entry.requirement, entry.status);

    row.append(label, value);
    list.append(row);
  }
}

function renderCallout(document, view) {
  const callout = document.getElementById('callout');
  const title = document.getElementById('callout-title');
  const body = document.getElementById('callout-body');

  callout.classList.remove('is-ready', 'is-blocked');

  if (view.state === 'ready') {
    callout.hidden = false;
    callout.classList.add('is-ready');
    // Not "you may join now". The companion is never told how the server judged the
    // snapshot (ADR 0004), so on a server that requires more than this machine offers, a
    // promise here would be contradicted by the connect screen seconds later.
    title.textContent = 'Prüfung abgeschlossen.';
    body.textContent =
      'Lass FiveProtect im Hintergrund laufen, solange du spielst. Über den Beitritt entscheidet der Server.';
    return;
  }

  if (view.state === 'blocked') {
    callout.hidden = false;
    callout.classList.add('is-blocked');
    title.textContent = 'Das ist zu tun';
    // The backend's remediation text, verbatim. Design document 12.2: naming the concrete
    // cause is the difference between a support ticket and none, and the backend is the
    // only side that knows the cause.
    body.textContent =
      view.remediation ??
      'Der Server hat keine genauere Begründung geliefert. Starte FiveProtect neu und versuche es erneut.';
    return;
  }

  callout.hidden = true;
}

function renderActions(document, view) {
  const actions = document.getElementById('actions');
  const primary = document.getElementById('action-primary');

  if (view.state === 'blocked') {
    actions.hidden = false;
    primary.textContent = 'Erneut prüfen';
    return;
  }

  // Nothing to press while a check runs or while the window is waiting. A button that does
  // nothing invites clicking it and then reporting that it does nothing.
  actions.hidden = true;
}

// --- Shell wiring -----------------------------------------------------------

/**
 * Subscribes to the shell's state events.
 *
 * The Rust side owns the state machine and pushes updates; the window never polls and never
 * asks for a verdict.
 */
export function connectToShell(document, tauri) {
  if (tauri?.event?.listen === undefined) return false;

  void tauri.event.listen('fiveprotect://state', (event) => {
    render(document, event.payload);
  });

  document.getElementById('action-primary').addEventListener('click', () => {
    void tauri.core.invoke('recheck');
  });
  document.getElementById('action-secondary').addEventListener('click', () => {
    void tauri.core.invoke('export_diagnostics');
  });

  return true;
}

/**
 * Subscribes to the native shell.
 *
 * The shell pushes a view by calling `host.__fiveprotect.push`; there is no request the page can
 * make for one. That direction is the whole point — a page that could ask for its state
 * would be a page an attacker could ask instead (ADR 0004).
 *
 * @param {Document} document
 * @param {{ipc?: {postMessage: (message: string) => void}} & Record<string, unknown>} host
 */
export function connectToNativeShell(document, host) {
  if (typeof host?.ipc?.postMessage !== 'function') return false;

  host.__fiveprotect = {
    push: (view) => {
      render(document, view);
    },
  };

  const send = (command) => {
    host.ipc.postMessage(JSON.stringify({ command }));
  };

  document.getElementById('action-primary').addEventListener('click', () => {
    send('recheck');
  });
  document.getElementById('action-secondary').addEventListener('click', () => {
    send('export_diagnostics');
  });

  // The window has no system frame, so dragging and the two controls are ours to provide.
  document.getElementById('window-minimize').addEventListener('click', () => {
    send('minimize');
  });
  document.getElementById('window-close').addEventListener('click', () => {
    send('close');
  });

  document.getElementById('titlebar').addEventListener('mousedown', (event) => {
    // Left button only, and never from a control — otherwise pressing close would start a
    // drag and the click would land somewhere else entirely.
    if (event.button !== 0) return;
    if (event.target.closest('button') !== null) return;
    send('drag');
  });

  return true;
}

// Bootstraps only when the module is loaded by the page it belongs to. A test runner
// imports this file to reach `render`, and it must not paint anything on the way in.
if (typeof document !== 'undefined' && document.getElementById('window') !== null) {
  const host = globalThis.window;
  const attached = connectToShell(document, host?.__TAURI__) || connectToNativeShell(document, host);
  if (!attached) {
    // Opened directly in a browser rather than through the shell. Rendering the idle state
    // keeps the page reviewable without a Rust toolchain.
    render(document, { state: 'idle' });
  }
}
