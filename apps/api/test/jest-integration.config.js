/**
 * Tests d'INTEGRATION.
 *
 * Perimetre : services metier contre une VRAIE base PostgreSQL, migrations
 * comprises. C'est ici que sont verifiees les garanties portees par le schema
 * (isolation multi-tenant, contraintes de stock, index d'idempotence).
 *
 * `maxWorkers: 1` est indispensable : les suites partagent une base unique et
 * la vident entre chaque test. Deux workers concurrents s'effaceraient
 * mutuellement leurs donnees, produisant des echecs erratiques impossibles a
 * diagnostiquer.
 */

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'integration',
  rootDir: '..',
  testEnvironment: 'node',
  testRegex: 'test/integration/.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@ecomflow/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  globalSetup: '<rootDir>/test/support/global-setup.ts',
  globalTeardown: '<rootDir>/test/support/global-teardown.ts',
  setupFilesAfterEnv: ['<rootDir>/test/support/setup-after-env.ts'],
  // Le demarrage de PostgreSQL et l'application des migrations peuvent prendre
  // une dizaine de secondes sur un poste modeste.
  testTimeout: 60_000,
  maxWorkers: 1,
  clearMocks: true,
  forceExit: false,
};
