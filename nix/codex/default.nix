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
    version = "0.144.1";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-NlpWhRcPZrrVjdHauwRi37gk+CqHC8yNmvLrCkHPLhg=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-A+cIyRg0vnlVWaN3uBzBKIHm2FL/pChpNybypH5hMuA=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-JcZtRFHE9X32tCcXPtfT1+KcEp1h3FhJjb25Rnh7dlU=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-4qZNQhwQqvC348DovXG3Hkl9dYIwAzGLZ0onjXGt0Mc=";
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
