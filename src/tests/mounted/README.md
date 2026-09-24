# Mounted component tests

Run `npm run test:ui` from `src` with the project's Node 24 runtime. The separate Vitest configuration collects only `tests/mounted/**/*.test.ts(x)`; existing Node server and pure data tests keep their own runners.

Use React Testing Library with `userEvent.setup()` and accessible roles/labels to test actual interactions. Render route-dependent components inside `createMemoryRouter` / `RouterProvider` or `MemoryRouter`. Every network response must be explicitly mocked with fictional fixtures: the shared setup rejects unexpected fetches. No live database, server, assistant, or model is used.

The setup includes jest-dom assertions, DOM cleanup, matchMedia / ResizeObserver / pointer-capture / scroll stubs and restores timers/global mocks after each test. Tests that exercise profile boundaries should explicitly select a fictional profile before rendering and switch with the real profile store inside `act()`.
