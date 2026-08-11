import { describe, expect, it, vi } from 'vitest';

import { PORT_RANGE_END, PORT_RANGE_START, commandFrom, createTransport } from './transport.js';

/**
 * The port search, without a browser.
 *
 * This is the piece of phase 1 most likely to break in the field — firewalls, security
 * software, another program on the same port — so the failure modes are worth pinning down
 * here rather than discovering them one support ticket at a time.
 */

const COMMAND = {
  nonce: 'a'.repeat(64),
  backendUrl: 'https://api.fiveprotect.dev',
  protocolVersion: 1,
};

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

/** A fake fetch where exactly one port answers like the companion. */
function companionOn(port, { body } = {}) {
  return vi.fn(async (url) => {
    const match = /^http:\/\/127\.0\.0\.1:(\d+)\/attest$/.exec(url);
    if (match === null || Number(match[1]) !== port) {
      throw new TypeError('connection refused');
    }
    return {
      ok: true,
      json: async () => body ?? { accepted: true, companionVersion: '0.1.0', protocolVersion: 1 },
    };
  });
}

function transportWith(fetch, storage = memoryStorage()) {
  // A pre-made signal keeps the tests free of real timers.
  return createTransport({ fetch, storage, timeoutSignal: () => new AbortController().signal });
}

describe('finding the companion', () => {
  it('finds a port in the middle of the range', async () => {
    const fetch = companionOn(52847);
    const transport = transportWith(fetch);

    await expect(transport.deliver(COMMAND)).resolves.toBe(52847);
  });

  it('finds the first and the last port of the range', async () => {
    for (const port of [PORT_RANGE_START, PORT_RANGE_END]) {
      const transport = transportWith(companionOn(port));
      await expect(transport.deliver(COMMAND)).resolves.toBe(port);
    }
  });

  it('reports nothing found when the companion is not running', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('connection refused');
    });
    const transport = transportWith(fetch);

    await expect(transport.deliver(COMMAND)).resolves.toBeNull();
    // The whole range was tried before giving up.
    expect(fetch).toHaveBeenCalledTimes(PORT_RANGE_END - PORT_RANGE_START + 1);
  });
});

describe('the remembered port', () => {
  it('is used first, so the common case is a single request', async () => {
    const fetch = companionOn(52810);
    const transport = transportWith(fetch, memoryStorage({ 'fiveprotect.port': '52810' }));

    await expect(transport.deliver(COMMAND)).resolves.toBe(52810);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('is written after a successful scan', async () => {
    const storage = memoryStorage();
    const transport = transportWith(companionOn(52833), storage);

    await transport.deliver(COMMAND);
    expect(storage.getItem('fiveprotect.port')).toBe('52833');
  });

  it('falls back to a scan when the companion moved', async () => {
    const fetch = companionOn(52890);
    const storage = memoryStorage({ 'fiveprotect.port': '52801' });
    const transport = transportWith(fetch, storage);

    await expect(transport.deliver(COMMAND)).resolves.toBe(52890);
    expect(storage.getItem('fiveprotect.port')).toBe('52890');
  });

  it('ignores a stored value outside the range', async () => {
    const fetch = companionOn(52805);
    const transport = transportWith(fetch, memoryStorage({ 'fiveprotect.port': '8080' }));

    await expect(transport.deliver(COMMAND)).resolves.toBe(52805);
    // 8080 was never contacted; a stale value must not send the nonce somewhere arbitrary.
    expect(fetch.mock.calls.every(([url]) => !url.includes(':8080'))).toBe(true);
  });

  it('works when storage is unavailable', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
    };
    const transport = transportWith(companionOn(52820), throwing);

    await expect(transport.deliver(COMMAND)).resolves.toBe(52820);
  });
});

describe('telling the companion apart from anything else listening', () => {
  it('ignores a port that answers with something else', async () => {
    // Any local process can sit on a port in the range. Accepting the first thing that
    // answers would send the nonce to it.
    const transport = transportWith(companionOn(52840, { body: { hello: 'world' } }));
    await expect(transport.deliver(COMMAND)).resolves.toBeNull();
  });

  it('ignores an answer that is not JSON', async () => {
    const fetch = vi.fn(async (url) => {
      if (!url.includes('52850')) throw new TypeError('connection refused');
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError('not JSON');
        },
      };
    });
    await expect(transportWith(fetch).deliver(COMMAND)).resolves.toBeNull();
  });

  it('ignores a non-2xx answer', async () => {
    const fetch = vi.fn(async (url) => {
      if (!url.includes('52860')) throw new TypeError('connection refused');
      return { ok: false, json: async () => ({ accepted: true, companionVersion: '0.1.0' }) };
    });
    await expect(transportWith(fetch).deliver(COMMAND)).resolves.toBeNull();
  });

  it('ignores an acknowledgement without a version', async () => {
    const transport = transportWith(companionOn(52870, { body: { accepted: true } }));
    await expect(transport.deliver(COMMAND)).resolves.toBeNull();
  });
});

describe('what is sent', () => {
  it('posts JSON to /attest without credentials', async () => {
    const fetch = companionOn(52802);
    await transportWith(fetch).deliver(COMMAND);

    const [url, init] = fetch.mock.calls.find(([candidate]) => candidate.includes('52802'));
    expect(url).toBe('http://127.0.0.1:52802/attest');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body)).toEqual(COMMAND);
  });
});

describe('the command built from a NUI message', () => {
  it('carries only what the protocol declares', () => {
    const command = commandFrom({
      type: 'fiveprotect:attest',
      nonce: 'a'.repeat(64),
      backendUrl: 'https://api.fiveprotect.dev',
      serverName: 'Nordstadt Roleplay',
      protocolVersion: 1,
      somethingElse: 'should not travel',
    });

    expect(Object.keys(command).sort()).toEqual(
      ['backendUrl', 'nonce', 'protocolVersion', 'serverName'].sort(),
    );
  });

  it('omits an empty server name rather than sending a blank one', () => {
    const command = commandFrom({
      nonce: 'a'.repeat(64),
      backendUrl: 'https://api.fiveprotect.dev',
      serverName: '',
      protocolVersion: 1,
    });
    expect(command.serverName).toBeUndefined();
  });
});
