{
  flake-utils,
  nixpkgs,
  ...
}:
let
  systems = [
    "aarch64-darwin"
    "x86_64-darwin"
    "aarch64-linux"
    "x86_64-linux"
  ];
in
flake-utils.lib.eachSystem systems (
  system:
  let
    pkgs = import nixpkgs { inherit system; };
    version = "0.143.0";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-TvuHHUCZk8HH0hA7DOt/xRqiy2roXQotvbdyZ4xw62A=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-v9JAcm5JkuDzIfNHsppLgQ0aOzg50jDhNnmNpwcbx6g=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-LwMMIT9IVFGY4SaLALrWCo8zxRG8JupKEfECZoGeeb8=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-zInNgYTt76ns2Vf5NMSXD58XtNKcDuwjJZd1pqDY/g4=";
        };
      }
      .${system};
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@openai/codex/-/codex-${version}-${platform.npm}.tgz";
      hash = platform.hash;
    };
  in
  {
    packages.codex =
      pkgs.runCommand "codex-${version}"
        {
          pname = "codex";
          inherit src version;
        }
        ''
          tar -xzf "$src"
          install -Dm755 package/vendor/*/codex/codex "$out/bin/codex"
        '';
  }
)
