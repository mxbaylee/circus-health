# Code formatting

From the repository root, install dependencies with `npm ci`, then run:

```sh
npm run format
npm run format:check
```

Prettier is pinned in `package.json` and its lockfile. The root configuration uses a 100-column target, two-space indentation, semicolons, single quotes, and preserved prose wrapping. Other options use Prettier defaults. The width is a wrapping preference: long strings, URLs, and other indivisible syntax may exceed it.

See Prettier's [options](https://prettier.io/docs/options) and [CLI reference](https://prettier.io/docs/cli). Formatting expands compressed source into conventional blocks; it does not rename symbols, reorganize modules or add behavioral lint requirements.

The scripts explicitly select application, server, shared, script, and test TypeScript/TSX, CSS, HTML, and manually maintained JSON; top-level application configuration; the formatter configuration; the design palette; and the intake envelope schema. They do not recursively format the repository parent. Root Git ignore rules and `.prettierignore` exclude generated output, dependencies, lockfiles, the generated icon catalog, and runtime data. The archive exclusions are scoped so `src/app/data/` remains formatted application source. Keep personal archives outside Git and outside these source directories.

Markdown documentation, archived mockups, reference assets, generated validation evidence, Python, and shell files are outside the formatting scope. Formatting has no automatic Git hook. The separate Husky commit-message hook accepts any leading Unicode emoji or an existing Gitmoji shortcode, with documented merge exemptions and bypasses in [Contributing](../CONTRIBUTING.md). Review formatting separately from behavior changes, and run the existing application checks after broad source formatting.
