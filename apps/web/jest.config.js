/**
 * Tests du frontend.
 *
 * PERIMETRE VOLONTAIREMENT ETROIT : la logique pure et les invariants de
 * donnees. Rendre des composants React demanderait jsdom, Testing Library et
 * un harnais de rendu, pour verifier surtout que React fonctionne — ce dont on
 * ne doute pas.
 *
 * Ce qui merite un test ici est ce qu'aucune verification de types ne peut
 * attraper : la coherence entre les deux catalogues de traduction. Une cle
 * manquante en arabe compile parfaitement et ne se voit qu'a l'ecran d'un
 * utilisateur arabophone.
 */

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'web',
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: 'src/.*\\.spec\\.ts$',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          jsx: 'react-jsx',
          esModuleInterop: true,
          resolveJsonModule: true,
          strict: true,
        },
        isolatedModules: true,
      },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  moduleNameMapper: {
    '^@ecomflow/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  clearMocks: true,
};
