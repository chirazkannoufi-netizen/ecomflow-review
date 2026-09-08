/**
 * Tests DE BOUT EN BOUT.
 *
 * Perimetre : l'application NestJS complete, montee en memoire, sollicitee par
 * de vraies requetes HTTP (supertest), contre une vraie base PostgreSQL.
 * Gardes, filtres d'exception, validation et serialisation sont donc tous
 * exerces — exactement comme en production.
 *
 * Ces suites couvrent les parcours exiges par le cahier des charges :
 * Google Sheets -> commande -> confirmation -> preparation -> expedition ->
 * tracking -> livraison, ainsi que le cycle essai -> expiration -> paiement.
 */

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'e2e',
  rootDir: '..',
  testEnvironment: 'node',
  testRegex: 'test/e2e/.*\\.spec\\.ts$',
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
  // Le hachage Argon2id est volontairement lent : un parcours qui enchaine
  // plusieurs inscriptions et connexions depasse largement le delai par defaut.
  testTimeout: 120_000,
  maxWorkers: 1,
  clearMocks: true,
};
