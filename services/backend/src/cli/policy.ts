import { createPool } from '../db/pool.js';

/**
 * Shows or changes a tenant's policy tier and fail mode.
 *
 * Design document 7.3 is emphatic that a tier is switched on deliberately and never as a
 * side effect: `standard` starts requiring Secure Boot, TPM, memory integrity and the driver
 * blocklist, and on a real customer that locks out a measurable share of players overnight.
 * So this prints what would change before it changes anything.
 *
 *   npm run -w @fiveprotect/backend policy
 *   npm run -w @fiveprotect/backend policy -- --tier standard
 *   npm run -w @fiveprotect/backend policy -- --fail-mode fail_closed
 */

const TIERS = ['relaxed', 'standard', 'strict'] as const;
const FAIL_MODES = ['fail_open', 'fail_closed'] as const;

/** What each tier starts enforcing, for the line printed before a change is applied. */
const ADDS: Record<(typeof TIERS)[number], string> = {
  relaxed: 'Companion läuft, Testsignatur aus, Kernel-Debugger aus, FiveM auf demselben PC',
  standard: '+ Secure Boot, TPM 2.0, Speicherintegrität (HVCI), Treiber-Sperrliste',
  strict: '+ Kernel-DMA-Schutz (IOMMU)',
};

interface TenantRow {
  id: string;
  name: string;
  policyTier: (typeof TIERS)[number];
  failMode: (typeof FAIL_MODES)[number];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined) {
    process.stderr.write('DATABASE_URL is not set\n');
    process.exit(1);
  }

  const tier = valueOf(args, '--tier', TIERS);
  const failMode = valueOf(args, '--fail-mode', FAIL_MODES);

  const pool = createPool(connectionString);
  try {
    const { rows } = await pool.query<TenantRow>(
      `SELECT id, name, policy_tier AS "policyTier", fail_mode AS "failMode"
         FROM tenants ORDER BY created_at`,
    );

    if (rows.length === 0) {
      process.stdout.write('Kein Mandant angelegt. Erst `provision` ausführen.\n');
      return;
    }

    if (tier === undefined && failMode === undefined) {
      process.stdout.write('\nMandanten:\n\n');
      for (const row of rows) {
        process.stdout.write(`  ${row.name}\n`);
        process.stdout.write(`    Stufe:      ${row.policyTier} — ${ADDS[row.policyTier]}\n`);
        process.stdout.write(`    Fail-Modus: ${row.failMode}\n\n`);
      }
      process.stdout.write('Ändern mit --tier <stufe> oder --fail-mode <modus>.\n\n');
      return;
    }

    // One tenant per local deployment. Naming which one would be the next thing to add here
    // if that ever stops being true.
    if (rows.length > 1) {
      process.stderr.write('mehr als ein Mandant — dieser Befehl kann sie nicht auseinanderhalten\n');
      process.exit(1);
    }

    const target = rows[0];
    if (target === undefined) throw new Error('no tenant to update');

    await pool.query('UPDATE tenants SET policy_tier = $2, fail_mode = $3 WHERE id = $1', [
      target.id,
      tier ?? target.policyTier,
      failMode ?? target.failMode,
    ]);

    const nextTier = tier ?? target.policyTier;
    process.stdout.write(
      [
        '',
        `${target.name} aktualisiert:`,
        `  Stufe:      ${nextTier} — ${ADDS[nextTier]}`,
        `  Fail-Modus: ${failMode ?? target.failMode}`,
        '',
        'Gilt ab der nächsten Verbindung. Laufende Sitzungen bleiben unberührt.',
        '',
      ].join('\n'),
    );
  } finally {
    await pool.end();
  }
}

function valueOf<T extends readonly string[]>(
  args: string[],
  flag: string,
  allowed: T,
): T[number] | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;

  const value = args[index + 1];
  if (value === undefined || !allowed.includes(value)) {
    process.stderr.write(`${flag} muss eines von ${allowed.join(', ')} sein\n`);
    process.exit(1);
  }
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`policy failed: ${String(error)}\n`);
  process.exit(1);
});
