/** Retired portable operator commands. Refuse before inspecting any archive or arguments. */
process.stderr.write(
  'Offline recovery commands are retired; no files were inspected or changed.\n' +
    'For the encrypted archive, stop the Compose writer (Ctrl-C), then copy the complete CRS_DATA_DIR consistently.\n' +
    'Keep recovery kits separately. A recovery kit or SQLite cache is not an archive backup.\n' +
    'Use npm run help and docs/setup/deployment.md for the supported backup/restore procedure.\n',
);
process.exitCode = 1;
