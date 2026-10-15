# Sourced by the service, login shells and BASH_ENV. No downloads or writes.
export CODEX_TOOLS_ROOT="${CODEX_TOOLS_ROOT:-/data/tools}"
export CODEX_TOOLS_BIN="${CODEX_TOOLS_BIN:-/data/bin}"
export LANG="${LANG:-C.UTF-8}"
_codex_tools_prepend() {
  case ":${PATH-}:" in
    *:"$1":*) ;;
    *) PATH="$1${PATH:+:$PATH}" ;;
  esac
}
_codex_tools_prepend "$CODEX_TOOLS_BIN"
export GOPATH="${GOPATH:-$HOME/go}"
_codex_tools_prepend "$GOPATH/bin"
# Re-sourcing must not replace a project's explicitly activated environment.
if [ -z "${VIRTUAL_ENV-}" ] && [ -x "$CODEX_TOOLS_ROOT/python/venv/bin/python" ]; then
  VIRTUAL_ENV="$CODEX_TOOLS_ROOT/python/venv"
fi
if [ -n "${VIRTUAL_ENV-}" ] && [ -d "$VIRTUAL_ENV/bin" ]; then
  _codex_tools_prepend "$VIRTUAL_ENV/bin"
  export VIRTUAL_ENV
fi
export PATH
export JAVA_HOME="${JAVA_HOME:-$CODEX_TOOLS_ROOT/java/25}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$CODEX_TOOLS_ROOT/python/managed}"
export UV_PYTHON_BIN_DIR="${UV_PYTHON_BIN_DIR:-$CODEX_TOOLS_ROOT/python/bin}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-$CODEX_TOOLS_ROOT/python/uv-tools}"
export UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-$CODEX_TOOLS_BIN}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-$HOME/.cache/uv}"
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$HOME/.cache/pip}"
export GOCACHE="${GOCACHE:-$HOME/.cache/go-build}"
export GOMODCACHE="${GOMODCACHE:-$GOPATH/pkg/mod}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}"
export BASH_ENV="${BASH_ENV:-$CODEX_TOOLS_ROOT/env.sh}"
unset -f _codex_tools_prepend
