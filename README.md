# codex-web

a browser frontend for codex desktop, running on a machine you control.

This is the maintained [maolei1024 fork](https://github.com/maolei1024/codex-web)
of [0xcaff/codex-web](https://github.com/0xcaff/codex-web). It includes token and
cookie authentication, bounded uploads, browser downloads, mobile layout and
reconnection improvements, and compressed, versioned assets. The Desktop bundle
is pinned to `26.901.41123`; the host supplies the Codex CLI.

Use one source checkout. User projects belong in `~/ChatGPT`, and credentials
belong in the service environment outside Git. `CODEX_WEB_DOCUMENTS_DIR` can
override the parent of the `ChatGPT` project directory. Build output under
`scratch/` and `src/server/` is generated and ignored. Keep historical versions
in Git instead of copying the checkout to dated directories.

For local development, run `npm ci` with Node 22 or later, `unzip`, `patch`, and
the native build tools required by the dependencies installed. The prepare
lifecycle downloads and patches the pinned Desktop bundle. `npm test` builds
the server and browser and runs the regression tests. A source update does not
change an existing service deployment.

`local-build.json` is the tracked asset-version manifest. Change its ID when
shipping changed browser assets, then rebuild; the server checks that this ID
matches the generated `asset-version.json` before serving them.

Versioned assets, including the browser preload, are immutable for one year.
Reverse proxies must preserve their `Cache-Control` header without appending
`no-cache`; unversioned preload URLs still revalidate. HTML stays revalidatable
so a new release selects the new asset namespace. Authentication is checked
before serving assets; conversation data is not part of the static asset cache.

Feature configuration uses an identity-scoped snapshot when available. On a
cache miss, the Statsig SDK waits at most one second for remote configuration,
then starts with its existing cached values/defaults and refreshes in the
background. Remote configuration failures must not hold the Web shell behind
network retries. This does not change account authorization or model requests.
The browser publishes its SDK evaluations without subscribing to a full snapshot
from other renderers. Shared-object updates go only to subscribing WebSocket
clients; disconnects release Desktop subscription references, so refreshes do
not accumulate subscriptions or queue unused configuration ahead of history.
The browser restores active subscriptions on reconnect before flushing pending
subscription changes, including after failed connection attempts.

Unsent image attachments are saved in this browser's IndexedDB alongside the
existing text draft behavior. Refreshing restores the images to the same task's
composer (including the new-task composer). Original image data is retained, so
restored images remain sendable after temporary server uploads expire. Removing
an image or sending the draft clears its saved attachment; saving does not run
on every text keystroke. If browser storage is unavailable or full, an alert
appears. Draft images stay on this browser and origin: they are not synced across
devices and are removed when site data is cleared. Files still being read or
uploaded when the page is interrupted may not yet have a saved draft.

https://github.com/user-attachments/assets/0a33cbd8-741c-412c-9e75-46dfe9324596

## motivation

the agents were never meant to stay trapped in a terminal window for long.
codex desktop brought the power of agents to your local computer, where your
files, credentials, and tools already live.

codex-web brings codex desktop to the browser while keeping the backend on a
machine you control (a linux box in the cloud, your home lab, or a desktop / mac
mini). agents keep running after your laptop closes. you can reconnect from any
device with a browser.

this project aims to be as thin a wrapper as possible to ensure upstream changes
to the codex desktop app can be integrated quickly.

## usage

`codex-web` serves the browser client and hosts the desktop-side bridge. by
default, it listens on `127.0.0.1:8214`.

it will use `codex` from `PATH` if available, or `CODEX_CLI_PATH` if you set
it.

run it with `npx`:

```bash
npx --yes github:maolei1024/codex-web
```

or with nix:

```bash
nix run github:maolei1024/codex-web
```

then open <http://127.0.0.1:8214> in a browser.

### sign in

ensure the codex cli on the host machine is signed in before starting the
server.

```bash
codex login --device-auth
```

### proxying to app-server (advanced usage)

it’s often useful to run the app server separately, so a crash or restart of
codex-web doesn’t interrupt the codex process executing commands.

it's possible to hook codex-web up to an already-running app server using the
`codex_remote_proxy` script.

start a long-lived app server somewhere:

```bash
mkdir -p /tmp/codex-app-server
cd /tmp/codex-app-server
codex app-server --listen unix://codex-app-server.sock
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

`codex app-server proxy --sock ...` is a raw stdio protocol bridge for another
program to use; when run directly in a terminal it will wait for protocol input
rather than opening an interactive prompt.

## Container and cluster deployment

The container pins Node 22.22.0, Codex CLI 0.156.1 and the Desktop version above.
Its native amd64 and arm64 builds run `npm test` and a packaged runtime smoke
check before publication. Woodpecker builds on `main` push/manual, publishes
`docker.nexus.ixuni.win/codex/web:build-N`, and applies `k8s/codex-web.yaml`.
Both architectures must pass before the combined image and `latest` are published.
The deployment uses a single replica on ml256 with a hostPath at
`/srv/k3s-local/project-codex-web/codex-web`, mounted at `/data`. Before the first
deployment, create this directory on ml256 with UID/GID 1000 and mode 0700:

```sh
sudo install -d -o 1000 -g 1000 -m 0700 /srv/k3s-local/project-codex-web/codex-web
```

The manifest requires the directory to exist and keeps `Recreate` updates and
the ml256 node selector. Storage uses the host filesystem's available capacity;
there is no PVC or 10 GiB volume quota. Back up this directory with the application
stopped before moving the deployment to another host.

Mount persistent storage at `/data`. The container keeps its home in `/data/home`,
Codex state in `/data/codex`, Electron state in `/data/app`, documents in
`/data/documents/ChatGPT`, and bounded temporary uploads in `/data/uploads`.
Outside containers, `CODEX_WEB_DATA_DIR` optionally relocates Electron userData,
sessionData, cache, logs and temp; unset preserves the existing defaults.
`CODEX_WEB_DEBUG_IPC=1` enables verbose IPC logging, including potentially sensitive
arguments. It is off by default.

Provision `project-codex-web/codex-web-auth` with a `token` key and
`project-codex-web/codex-web-seed` before the first CI deployment. The seed Secret
accepts `config.toml`, `auth.json`, `remote-connections.json`, `ssh-config`,
`ssh-known-hosts`, and `ssh-private-key`. Initial config/auth/remote connections
are copied only when absent; SSH material is refreshed on container startup.
Keep credentials, real project inventories and these Secret values outside Git.
The connection seed follows the Desktop schema:

```json
{"version":1,"remoteConnections":[{"sshAlias":"development-host","projects":[{"remotePath":"/srv/projects/example","label":"Example"}]}]}
```

For an independent backend on the project host, install the user unit from
`deploy/codex-web-remote.service` and copy `scripts/remote-start` and
`scripts/remote-ssh-command` to `/srv/services/codex-web-remote/bin/start` and
`bin/ssh-command`. Create a private `env` file in that service directory defining
`CODEX_HOME`, `CODEX_CLI_PATH`, `CODEX_INSTALL_DIR` and `PATH`, using an independent
state directory and the installed CLI. Seed required model/MCP/skill configuration
without copying conversations. Use a dedicated SSH key with the authorized_keys
option `restrict,command="/srv/services/codex-web-remote/bin/ssh-command"`, pin the
host key, and enable the user service with lingering. The wrapper selects that
backend's state and disables Desktop's automatic server bootstrap; it still
allows commands as the project owner. It is not a sandbox or command allowlist.

The Web instance uses native SSH/app-server transport. Project files, task
commands and MCP processes remain on the remote host. Existing services and
conversation stores can continue running independently.

## Security

run `codex-web` only on trusted networks. treat anyone who can reach the
`codex-web` server as someone who can operate codex on the host machine as the
same user running the server.

This fork requires `CODEX_WEB_TOKEN` when listening outside loopback. Visit
`?token=<token>` once to establish an HttpOnly cookie; the redirect removes the
token from the URL. Serve the application over trusted HTTPS and protect access
to the host. Keep tokens out of Git, proxy logs, and shared URLs.

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

- The saved language setting loads the Desktop translations, including Chinese.
- Project and chat context menus use Desktop's browser menu components.
- The sidebar's **View activity** button is available even when the upstream
  feature configuration cannot be fetched; Desktop's access checks still apply.
- Settings → Connections exposes native SSH hosts. Here “this computer” means
  the Web server: SSH configuration and keys must be available to that server.
  New remote projects use **Remote**, not **Cloud**.
- **Cloud** creates ChatGPT-hosted projects and requires a ChatGPT account with
  project access. A custom API-key provider supplies model inference, not those
  account APIs; this option remains disabled when that capability is unavailable.
- hostable on macOS, Linux (and anything codex cli + node will run on)
- reachable from the browser
- thin wrapper, so updates should land fast
- working today:
  - subagents
  - inline images
  - editor sidepanel
  - transcription

## roadmap

some parts of the desktop experience are not wired up yet:

- browser panel support, likely rebuilt around iframes
- computer use on linux, which could become a very powerful feature
- terminal support
- git worker integration
- whatever else people find and file issues for

## issues welcome

if something is broken, missing, or rough around the edges, please file an
issue.

using `codex-web` in an interesting way? post about it on x and tag me
[@0xcaff](https://x.com/0xcaff).

using this at a company and need something more tailored? email me and we can
talk.

## alternatives

* [davej/pocodex](https://github.com/davej/pocodex) i used this until the wheels fell off. i needed subagents
  and an inline image viewer. this didn't have them and was having a hard time
  keeping up with upstream codex updates.
* the native codex remote feature (behind a feature flag) is great for
  connecting to remote codex hosts over ssh to manage long running tasks but
  this only works if you have codex desktop on your client device. this means it
  doesn't work on mobile.
* upcoming first party mobile app from openai. `codex-web` exists and works
  today. i can't wait for the mobile app but judging by the other openai mobile
  apps, i'm a little bit skeptical about the quality of the mobile experience.
  time will tell.
