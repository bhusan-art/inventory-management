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

  /**
   * ARCHITECTURAL GUARDRAIL — the single write path for inventory.
   *
   * ARCHITECTURE.md §1.6 and business rule 2 depend on every quantity change
   * producing a ledger row. That is only structurally true if the code that
   * changes quantities is the same code that writes ledger rows.
   *
   * So: nothing outside src/services/inventory/ may call a mutating method on
   * the Inventory model. Reads are unrestricted.
   *
   * Uses `no-restricted-properties` rather than `no-restricted-syntax`
   * deliberately: flat config resolves rules by name, last match wins, so a
   * second `no-restricted-syntax` block covering the same files would silently
   * replace the restricted-field rule above rather than adding to it.
   */
  {
    files: ['src/**/*.js'],
    ignores: ['src/services/inventory/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate',
          'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'bulkWrite'].map((property) => ({
          object: 'Inventory',
          property,
          message:
            'Inventory quantities may only be changed by ' +
            'src/services/inventory/ledgerService.js, so that every movement produces a ' +
            'ledger row. See ARCHITECTURE.md §1.6.',
        })),
      ],
    },
  },

  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: { 'no-console': 'off' },
  },
];
