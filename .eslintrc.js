module.exports = {
  env: {
    commonjs: true,
    es6: true,
    node: true,
  },
  extends: 'airbnb-base',
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  parserOptions: {
    ecmaVersion: 2018,
  },
  rules: {
    quotes: ['error', 'single', { avoidEscape: true }],
    'func-names': ['error', 'never'],
    'space-before-function-paren': 0,
    'no-console': 0,
    'object-curly-newline': 0,
    'no-return-assign': ['error', 'except-parens'],
    'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
  },
};
