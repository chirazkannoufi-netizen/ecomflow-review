/**
 * Tests UNITAIRES.
 *
 * Perimetre : logique pure et services isoles, avec doubles. Aucune base de
 * donnees, aucun reseau. Ils doivent rester assez rapides pour tourner a
 * chaque sauvegarde.
 */

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'unit',
  rootDir: '..',
  testEnvironment: 'node',
  testRegex: 'src/.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        // `isolatedModules` accelere nettement la compilation en renoncant a
        // la verification de types inter-fichiers : celle-ci est deja assuree
        // par `npm run typecheck`, qui tourne en amont dans la CI.
        isolatedModules: true,
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@ecomflow/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/**/dto/**',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: '<rootDir>/coverage/unit',
  clearMocks: true,
};
