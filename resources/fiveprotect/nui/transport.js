/**
 * The localhost hop.
 *
 * ADR 0003: the companion binds 127.0.0.1 on a port from a fixed range and this frame finds
 * it. HTTP rather than a named pipe because this is a CEF instance — it can fetch, and it
 * cannot do anything else without a native extension inside the FiveM process, which is out
 * of scope by design (design document 3).
 *
 * This is the single largest integration risk in phase 1, which is why the gate was built
 * before the attestation: if firewalls or CEF behaviour break it, that has to be known in
 * week three rather than week fifteen. The logic is written as a factory over `fetch` and
 * storage so the port search can be tested without a browser.
 */

export const PORT_RANGE_START = 52800;
export const PORT_RANGE_END = 52899;

/** Per-attempt budget. A local connection either answers quickly or is not there. */
export const PROBE_TIMEOUT_MS = 600;

/** Where the last working port is remembered, so the common case is a single request. */
export const STORAGE_KEY = 'fiveprotect.port';

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {Storage|null} deps.storage
 * @param {(ms: number) => AbortSignal} [deps.timeoutSignal]
 */
export function createTransport({ fetch, storage, timeoutSignal }) {
  const abortAfter =
    timeoutSignal ??
    ((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });

  function rememberedPort() {
    try {
      const port = Number.parseInt(storage?.getItem(STORAGE_KEY) ?? '', 10);
      return port >= PORT_RANGE_START && port <= PORT_RANGE_END ? port : null;
    } catch {
      // Storage can be unavailable. That costs a scan, not correctness.
      return null;
    }
  }

  function rememberPort(port) {
    try {
      storage?.setItem(STORAGE_KEY, String(port));
    } catch {
      /* not worth reporting */
    }
  }

  /**
   * Sends the attest command to one port.
   *
   * Resolves to the port on success and to null on anything else. A closed port, a wrong
   * port and an unrelated program listening all look the same from here, and all of them
   * mean "keep looking".
   */
  async function tryPort(port, command) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/attest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: abortAfter(PROBE_TIMEOUT_MS),
        // No credentials: there is nothing to authenticate with, and sending any would only
        // hand them to whatever else might be listening on that port.
        credentials: 'omit',
        cache: 'no-store',
      });

      if (!response.ok) return null;

      const body = await response.json();
      // The companion answers with an acknowledgement and nothing else (ADR 0003). Checking
      // the shape stops an unrelated local service from being mistaken for the companion.
      const looksLikeCompanion =
        body !== null &&
        typeof body === 'object' &&
        body.accepted === true &&
        typeof body.companionVersion === 'string';

      return looksLikeCompanion ? port : null;
    } catch {
      return null;
    }
  }

  /**
   * Finds the companion and delivers the command.
   *
   * The remembered port is tried first, then the rest of the range in parallel. Parallel
   * because a hundred sequential probes at 600 ms each would outlive the 30-second nonce;
   * the requests go to loopback, so the cost of firing them together is negligible.
   */
  async function deliver(command) {
    const remembered = rememberedPort();
    if (remembered !== null) {
      const hit = await tryPort(remembered, command);
      if (hit !== null) return hit;
    }

    const ports = [];
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
      if (port !== remembered) ports.push(port);
    }

    const results = await Promise.all(ports.map((port) => tryPort(port, command)));
    const found = results.find((port) => port !== null);
    if (found === undefined) return null;

    rememberPort(found);
    return found;
  }

  return { deliver, tryPort, rememberedPort, rememberPort };
}

/** Builds the command from a NUI message, dropping anything the protocol does not declare. */
export function commandFrom(message) {
  const command = {
    nonce: message.nonce,
    backendUrl: message.backendUrl,
    protocolVersion: message.protocolVersion,
  };
  if (typeof message.serverName === 'string' && message.serverName.length > 0) {
    command.serverName = message.serverName;
  }
  return command;
}

// --- Browser wiring ---------------------------------------------------------
// Skipped under a test runner, where there is no window to attach to.

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const transport = createTransport({
    fetch: window.fetch.bind(window),
    storage: window.localStorage,
  });

  const resourceName =
    typeof window.GetParentResourceName === 'function' ? window.GetParentResourceName() : 'fiveprotect';

  const report = (reached, port) => {
    // Informational only. The backend already knows whether an attestation arrived, and it
    // would be unwise to let the client's word decide anything (ADR 0004). This exists so
    // the deferral can say "FiveProtect is not running" instead of making the player wait out
    // the timeout.
    window
      .fetch(`https://${resourceName}/fiveprotect:result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reached, port }),
      })
      .catch(() => {
        /* the server does not depend on this answer */
      });
  };

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'fiveprotect:attest') return;

    void transport.deliver(commandFrom(message)).then((port) => {
      report(port !== null, port);
    });
  });
}
