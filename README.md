# codex-web

a browser frontend for codex desktop, running on a machine you control.

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
npx --yes github:0xcaff/codex-web
```

or with nix:

```bash
nix run github:0xcaff/codex-web
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
codex app-server --listen unix:///tmp/codex-app-server.sock
```

then run `codex-web` with the proxy helper:

```bash
nix shell github:0xcaff/codex-web github:0xcaff/codex-web#codex_remote_proxy -c bash -lc '
  export CODEX_UNIX_SOCKET=/tmp/codex-app-server.sock
  export CODEX_CLI_PATH="$(command -v codex_remote_proxy)"
  codex-web
'
```

## security

treat anyone who can reach the `codex-web` server as someone who can operate
codex on the host machine as the same user running the server.

### token auth

for exposure beyond localhost, `codex-web` requires a fixed access token:

```bash
codex-web --host 0.0.0.0 --token my-secret-token
# or: CODEX_WEB_TOKEN=my-secret-token codex-web --host 0.0.0.0
```

binding to a non-loopback host without a token is refused at startup.
localhost stays token-free unless a token is configured.

to sign in, open `https://your-host/?token=my-secret-token` once. the server
sets an http-only cookie, redirects to strip the token from the url, and every
subsequent request (pages, assets, uploads, the websocket bridge) is
authenticated by that cookie.

when exposing to the public internet, terminate TLS in a reverse proxy
(caddy, nginx, cloudflare tunnel, ...) in front of `codex-web`. the proxy must
forward the `Upgrade`/`Connection` headers (websocket) and `X-Forwarded-Proto`
(so the auth cookie is marked `Secure`). sending the token over plain public
http leaks it.

uploads are capped at 100mb by default; tune with `--max-upload-bytes` or
`CODEX_WEB_MAX_UPLOAD_BYTES`.

alternatively, keep it off the public internet entirely: proxy through
wireguard, tailscale, or an ssh tunnel.

### reverse proxy (nginx)

proxy everything to `codex-web` — do **not** point nginx `root`/`try_files`
at the webview directory and do **not** enable `proxy_cache` for it: both
serve content without going through token auth. static assets are already
fast from the app server: content-hashed bundles get
`cache-control: immutable` (repeat visits skip the download entirely) and are
served pre-compressed (brotli/gzip, generated at build time).

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ""      close;
}

server {
  listen 443 ssl;
  http2 on;
  server_name codex.example.com;

  # ssl_certificate     /path/fullchain.pem;
  # ssl_certificate_key /path/privkey.pem;

  client_max_body_size 100m;  # keep in sync with --max-upload-bytes

  location / {
    proxy_pass http://127.0.0.1:8214;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;  # websocket idle; the server pings every 20s
  }
}
```

someone with access to the web ui may be able to:

- run commands on the host, limited only by the permissions of the `codex-web`
  server process.
- read or modify files, environment variables, credentials, ssh keys, and other
  local resources that are accessible to that process.
- use the codex / chatgpt account already signed in on the host. this may
  consume usage quota or billing credits, and may expose account metadata shown
  by the app or cli, such as name or email address.

## features

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
