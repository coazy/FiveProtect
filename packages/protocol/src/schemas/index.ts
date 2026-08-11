/**
 * Loading order is the generated declaration order.
 *
 * C++ has no forward declarations in the generated header and Rust reads better without
 * them, so a struct must be declared before anything that references it. `validateRegistry`
 * enforces this and names the offending field if the order is wrong.
 */
import './common.js';
import './attestation.js';
import './session.js';
import './local.js';

import { getRegistry, validateRegistry, type Registry } from '../ir.js';

export function loadRegistry(): Registry {
  const registry = getRegistry();
  validateRegistry(registry);
  return registry;
}
