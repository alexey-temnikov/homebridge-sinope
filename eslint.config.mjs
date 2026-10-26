import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  { files: ['test/**/*.cjs'], languageOptions: { globals: { require: 'readonly', module: 'readonly', setTimeout: 'readonly', process: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' } },
);
