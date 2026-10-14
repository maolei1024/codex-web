# Upgrading

Use the existing checkout and a Git branch. Running services use separate deployed
artifacts; preparing a build does not activate it. Keep Desktop and CLI versions
explicit, and validate the actual local and SSH app-server transports together.

## Release inputs

`local-build.json` is the single source for the Desktop version, archive SHA-256,
CLI version, four platform archive hashes and browser asset namespace. Docker,
Nix and `scripts/prepare` read this file. Give each changed browser build a new ID.
Download the pinned official packages, verify the Desktop appcast signature and
archive hashes, and update all manifest fields together. Do not silently follow
`latest` or infer the Linux CLI version from a macOS executable.

## Porting extraction patches

Create a task directory with `mktemp -d /tmp/codex-web-upgrade.XXXXXX` for downloaded
packages, pristine extracted files and comparisons with the previous build.
Keep generated working output in the checkout's ignored `scratch/` directory.
Do not create permanent source copies or delete other tasks' scratch material.

Use the previous patches to understand each behavior, then port it to the new
Desktop source. Review changed bundle names, native entrypoints, IPC transports,
React hooks and compiled memoization slots. Generate patch files from actual
before/after files with `diff`; do not hand-author their hunk offsets. Re-extract
the pinned archive and run `scripts/prepare_asar` with `HOSTED_CODEX_APP_ZIP` set.
Every patch must apply with the existing `--fuzz=0` setting. Update test extractors
to exercise the new native code, without weakening the behavior assertions.

## Validation and release

Run `npm test` and the existing release-contract checks. Build and smoke-test both
native Linux architectures. Test authenticated browser startup, real history,
streaming and tools on local and SSH hosts, reconnection, independent tabs,
notifications, image drafts, clipboard and downloads. Use isolated browser
contexts and test state; do not overwrite production histories or user drafts.
Check public HTTP/2 cold startup as well as the private network path.

A push or manual pipeline on `main` builds and automatically deploys the cluster.
Keep development work off `main` until the release window is ready. Use the
machine's configured Git author and a Chinese conventional commit message.

Before the approved cutover, establish that the affected app-servers have no
active work, stop their writers, and create consistent backups on each host under
`/backup/<UTC>-codex-web-upgrade/`, including configuration, state, startup
materials and recoverable old binaries/images. Check capacity before creating
backups. Include a restore manifest and retain backups until cleanup is agreed.
Update both app-server and SSH proxy resolution to the pinned CLI version.
Do not overwrite another instance's CODEX_HOME or restart unrelated Web services.

Verify the CI commit, image index and platform digests, actual Pod imageID, running
CLI executables and real browser behavior. Stop further cutovers on failure;
there is no automatic rollback. A database migration may require the matching
pre-upgrade state when restoring an old binary, so preserve post-upgrade changes
before any restore. Remove task-owned temporary files and test processes, and
report persistent changes and retained backups by host.
