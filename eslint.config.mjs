/**
 * Configuration ESLint du monorepo (format « flat », ESLint 9).
 *
 * PHILOSOPHIE : le linter ne doit signaler que ce qui a une conséquence réelle.
 * Une règle bruyante finit désactivée ligne par ligne, et le linter cesse alors
 * d'être lu — c'est pire que pas de linter du tout.
 *
 * Ce qui est traité en ERREUR ici a une conséquence identifiable :
 *   - une promesse non attendue (`no-floating-promises`) : une écriture en base
 *     peut être perdue sans le moindre message ;
 *   - un `await` oublié dans une condition (`no-misused-promises`) : un garde
 *     de sécurité testerait un objet Promise, donc toujours vrai ;
 *   - un `any` explicite : il désactive précisément la vérification qui protège
 *     les frontières entre modules.
 *
 * La mise en forme n'est PAS du ressort d'ESLint : Prettier s'en charge, et
 * `eslint-config-prettier` neutralise les règles qui entreraient en conflit.
 */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // `projectService` laisse TypeScript résoudre lui-même le tsconfig de
        // chaque fichier : indispensable dans un monorepo où l'API, le front et
        // le paquet partagé ont des configurations distinctes.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // --- Correction ------------------------------------------------------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',

      // Une variable inutilisée est souvent le vestige d'un remaniement
      // incomplet. Le préfixe `_` permet de marquer une omission délibérée.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // --- Assouplissements assumés ----------------------------------------
      // Prisma et les corps de requête produisent des valeurs faiblement
      // typées aux frontières. Les traiter en erreur imposerait des assertions
      // partout, ce qui donnerait moins de sûreté, pas plus.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // L'interpolation d'un identifiant ou d'un nombre dans un message de
      // journal est idiomatique et sans risque ici.
      '@typescript-eslint/restrict-template-expressions': 'off',

      // NestJS déclare de nombreuses méthodes de cycle de vie asynchrones par
      // contrat d'interface, même sans `await` dans leur corps.
      '@typescript-eslint/require-await': 'off',
    },
  },

  // --- Tests : contraintes allégées ----------------------------------------
  {
    files: ['**/*.spec.ts', '**/test/**/*.ts'],
    rules: {
      // Une doublure de test décrit délibérément une forme partielle.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Doit rester en dernier : neutralise les règles de mise en forme.
  prettier,
);
