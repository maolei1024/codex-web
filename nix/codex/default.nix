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
    release = builtins.fromJSON (builtins.readFile ../../local-build.json);
    version = release.codexCliVersion;
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
        };
        aarch64-linux = {
          npm = "linux-arm64";
        };
        x86_64-linux = {
          npm = "linux-x64";
        };
      }
      .${system};
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/@openai/codex/-/codex-${version}-${platform.npm}.tgz";
      hash = release.codexCliHashes.${platform.npm};
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
          install -Dm755 package/vendor/*/bin/codex "$out/bin/codex"
          install -Dm755 package/vendor/*/bin/codex-code-mode-host "$out/bin/codex-code-mode-host"
        '';
  }
)
