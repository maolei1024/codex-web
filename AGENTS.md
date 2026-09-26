# codex-web maintenance

This repository is the source of the maintained fork of `0xcaff/codex-web`.

- Use the existing checkout as the single development directory. Preserve versions with commits, branches and tags; do not create dated source copies or permanent parallel checkouts.
- Keep user projects and documents outside this repository, under `~/ChatGPT` by default. Keep credentials in the host's service environment file. Build output, runtime caches and uploads are not source files.
- Keep this file and README focused on the current build, behavior and operational boundaries. Do not add investigation transcripts, incident timelines or deployment diaries.
- Preserve the token authentication, upload limits, browser downloads and local-file path checks when integrating upstream changes. The frontend is extracted from a pinned Desktop release; update the extraction patches together when changing that version.
- Validate server/browser changes with `npm test`. Build from source; do not commit generated JavaScript, extracted Desktop bundles or dependencies.
- Running services use their deployed artifacts. Updating this checkout or pushing a commit does not authorize an application version upgrade or a service restart.
