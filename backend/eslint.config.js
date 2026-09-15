import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'coverage/**', 'storage/**'] },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'warn',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-return-await': 'error',
    },
  },

  /**
   * ARCHITECTURAL GUARDRAIL — see ARCHITECTURE.md §5, layer 3.
   *
   * Restricted fields are `select: false` at the schema level, so the only way
   * to read one is an explicit `+field` projection. Confining that to the
   * repository layer means access control cannot be bypassed by a well-meaning
   * developer "just fixing" a missing field on a report six months from now.
   *
   * Repositories are exempt because that is where the permission-checked
   * helper lives; tests are exempt because they must be able to assert that a
   * field really is absent from a response.
   */
  {
    files: ['src/**/*.js'],
    ignores: ['src/repositories/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='select'] > Literal[value=/^\\s*\\+/]",
          message:
            'Selecting restricted fields is only permitted in src/repositories, via ' +
            'BaseRepository.selectRestricted(model, permissions). See ARCHITECTURE.md §5.',
        },
      ],
    },
  },

  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: { 'no-console': 'off' },
  },
];
