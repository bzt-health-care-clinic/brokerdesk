import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerGuardImportSpecifier, root } from './runtime.mjs';

assert.equal(new URL(providerGuardImportSpecifier).protocol, 'file:');
assert.equal(fileURLToPath(providerGuardImportSpecifier), resolve(root, 'tests/acceptance/provider-network-guard.mjs'));

await import(providerGuardImportSpecifier);
assert.throws(() => fetch('https://example.invalid/'), /Acceptance blocked an external backend request/);
console.log('PASS: file URL module specifier resolves and network guard remains active');
