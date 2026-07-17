import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import YAML from 'yaml';

import { checkProductionCompose } from './compose-check.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composePath = path.resolve(repositoryRoot, '..', 'deploy', 'compose.prod.yml');
const rawCompose = readFileSync(composePath, 'utf8');

/** Parse a fresh copy, break one thing, and report which rules fired. */
function mutated(mutate) {
  const doc = YAML.parse(rawCompose);
  mutate(doc);
  return checkProductionCompose(doc).map((v) => v.rule);
}

describe('the real deploy/compose.prod.yml', () => {
  test('passes every invariant', () => {
    expect(checkProductionCompose(YAML.parse(rawCompose))).toEqual([]);
  });

  test('declares exactly the five production services', () => {
    expect(Object.keys(YAML.parse(rawCompose).services).sort()).toEqual([
      'backend',
      'backup',
      'caddy',
      'migrate',
      'postgres',
    ]);
  });
});

// A checker that cannot fail is decoration. Each case breaks one thing and
// expects that specific rule to catch it.
describe('the checker catches what actually matters', () => {
  test('a published postgres port', () => {
    expect(mutated((d) => { d.services.postgres.ports = ['5432:5432']; })).toContain('postgres-no-published-ports');
  });

  test('a published backend port', () => {
    expect(mutated((d) => { d.services.backend.ports = ['3000:3000']; })).toContain('backend-no-published-ports');
  });

  test('postgres on the wrong major', () => {
    expect(mutated((d) => { d.services.postgres.image = 'postgres:18'; })).toContain('postgres-image');
  });

  test('the postgres:18 volume layout under a 17 server', () => {
    expect(mutated((d) => { d.services.postgres.volumes = ['pgdata:/var/lib/postgresql']; }))
      .toContain('postgres-volume-path');
  });

  test('internal network losing its isolation', () => {
    expect(mutated((d) => { d.networks.internal.internal = false; })).toContain('internal-network-isolated');
  });

  test('backend no longer waiting for migrate', () => {
    expect(mutated((d) => { delete d.services.backend.depends_on.migrate; })).toContain('backend-depends-migrate');
  });

  test('backend waiting for migrate to merely start', () => {
    expect(mutated((d) => { d.services.backend.depends_on.migrate.condition = 'service_started'; }))
      .toContain('backend-depends-migrate');
  });

  test('migrate not waiting for a healthy postgres', () => {
    expect(mutated((d) => { d.services.migrate.depends_on.postgres.condition = 'service_started'; }))
      .toContain('migrate-depends-postgres');
  });

  test('a backend healthcheck pointed at /ready', () => {
    expect(mutated((d) => {
      d.services.backend.healthcheck.test = ['CMD', 'bun', '-e', "fetch('http://127.0.0.1:3000/ready')"];
    })).toContain('backend-healthcheck-endpoint');
  });

  test('caddy publishing something other than 80/443', () => {
    expect(mutated((d) => { d.services.caddy.ports.push('5432:5432'); })).toContain('caddy-ports');
  });

  test('caddy reaching the database network', () => {
    expect(mutated((d) => { d.services.caddy.networks.push('internal'); })).toContain('caddy-network');
  });

  test('a secret written inline instead of interpolated', () => {
    expect(mutated((d) => { d.services.backend.environment.JWT_SECRET = 'hunter2-hunter2-hunter2-hunter2-12'; }))
      .toContain('no-inline-secrets');
  });

  test('a mismatched pg_dump major in the backup service', () => {
    expect(mutated((d) => { d.services.backup.image = 'postgres:16-alpine'; })).toContain('backup-image');
  });

  test('a missing restart policy', () => {
    expect(mutated((d) => { delete d.services.backend.restart; })).toContain('backend-restart');
  });

  test('a missing service', () => {
    expect(mutated((d) => { delete d.services.migrate; })).toContain('services');
  });
});
