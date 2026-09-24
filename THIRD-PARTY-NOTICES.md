# Third-party material

Circus Health's [MIT License](LICENSE) covers the project's own code and artwork. Dependencies and container components retain their own licenses and notices.

- **Application libraries.** [package.json](package.json) lists direct dependencies, and [package-lock.json](package-lock.json) records the installed versions and transitive dependencies. The installed packages retain their upstream license files under `node_modules`, including in the application image. Most direct dependencies declare MIT; PDF.js and Playwright declare Apache-2.0; libsodium-wrappers-sumo declares ISC. Consult each package's complete notices when redistributing it.
- **Interface icons.** Lucide declares ISC and includes MIT notices for icons derived from Feather. Keep both sets of upstream notices. The Circus Health logo and Moxie pixel drawing are maintained separately in this repository.
- **Brand build tooling.** The pinned `@resvg/resvg-wasm` package declares MPL-2.0 and provides the WebAssembly rasterizer used to generate PNG and ICO artwork. It is a development dependency, removed from the final application image when development dependencies are pruned. Keep its upstream license and dependency notices when redistributing the build tools; see [resvg-js](https://github.com/thx/resvg-js).
- **Passkey names.** The bundled [AAGUID lookup](src/server/passkey-provider-names.json) contains factual provider-name mappings from `passkeydeveloper/passkey-authenticator-aaguids`, pinned at commit `774b3cfc940a4138bc451ae4ec9b943bf9a44c1b`. Provider icons are not bundled. These names indicate a possible authenticator provider, not trust, endorsement, or PRF support.
- **Typography.** The interface requests fonts installed on the user's system. This repository does not distribute those font files.
- **Containers.** Node.js, Chromium, LiteLLM, Python, qpdf (used to copy scoped native PDF pages), and operating-system packages carry their own licenses. The project's MIT license does not relicense the complete container images. Retain the notices supplied by the pinned images and installed packages.

Review this file and the pinned dependency notices when changing dependencies, importing artwork, or publishing a separately packaged browser bundle.
