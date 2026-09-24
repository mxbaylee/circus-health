export default {
  extends: ['gitmoji'],
  // Keep Gitmoji's permissive check without imposing conventional-commit style.
  rules: {
    'type-enum': [0],
    'body-leading-blank': [0],
    'footer-leading-blank': [0],
    'header-max-length': [0],
    'scope-case': [0],
    'subject-empty': [0],
    'subject-full-stop': [0],
    'type-case': [0],
    'type-empty': [0],
  },
};
