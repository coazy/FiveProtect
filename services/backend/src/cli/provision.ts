import { randomBytes } from 'node:crypto';

import { createPool } from '../db/pool.js';
import { hashServerKey } from '../repositories/tenants.js';

/**
 * Creates a tenant and its first game server, and prints the server key once.
 *
 * The key is generated here and never stored in the clear — this output is the only time it
 * exists in readable form. That is deliberate: an operator who loses it gets a new one,
 * which is a smaller problem than a key sitting in a database somebody later dumps.
 *
 *   npm run -w @fiveprotect/backend provision -- "Nordstadt Roleplay" --tier standard
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args[0];
  if (name === undefined || name.startsWith('--')) {
    process.stderr.write(
      'usage: provision <tenant name> [--tier relaxed|standard|strict] [--fail-closed]\n',
    );
    process.exit(1);
  }

  const tierIndex = args.indexOf('--tier');
  const tier = tierIndex === -1 ? 'relaxed' : args[tierIndex + 1];
  if (!['relaxed', 'standard', 'strict'].includes(tier ?? '')) {
    process.stderr.write(`unknown tier: ${String(tier)}\n`);
    process.exit(1);
  }

  // New tenants start at relaxed unless told otherwise. Design document 7.3: switching a
  // tier on without the preview report locks out a real share of a customer's players.
  const failMode = args.includes('--fail-closed') ? 'fail_closed' : 'fail_open';

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(1);
  }

  const pool = createPool(connectionString);
  try {
    const serverKey = randomBytes(32).toString('hex');

    const { rows: tenantRows } = await pool.query<{ id: string }>(
      'INSERT INTO tenants (name, policy_tier, fail_mode) VALUES ($1, $2, $3) RETURNING id',
      [name, tier, failMode],
    );
    const tenantId = tenantRows[0]?.id;
    if (tenantId === undefined) throw new Error('tenant was not created');

    const { rows: serverRows } = await pool.query<{ id: string }>(
      'INSERT INTO game_servers (tenant_id, name, server_key_hash) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, `${name} #1`, hashServerKey(serverKey)],
    );
    const serverId = serverRows[0]?.id;
    if (serverId === undefined) throw new Error('server was not created');

    process.stdout.write(
      [
        '',
        `Tenant angelegt: ${name}`,
        `  Policy-Stufe:  ${tier}`,
        `  Fail-Modus:    ${failMode}`,
        '',
        'In die server.cfg des FiveM-Servers:',
        '',
        `  set fiveprotect_server_id "${serverId}"`,
        `  set fiveprotect_server_key "${serverKey}"`,
        '',
        'Der Schlüssel wird nicht gespeichert und lässt sich nicht erneut anzeigen.',
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`provision failed: ${String(error)}\n`);
  process.exit(1);
});
