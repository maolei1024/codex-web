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
    version = "0.153.4";
    platform =
      {
        aarch64-darwin = {
          npm = "darwin-arm64";
          hash = "sha256-U10wG0kTGr/aMmT5WfsN76QLvDBpdtmN28FcQkY2xVw=";
        };
        x86_64-darwin = {
          npm = "darwin-x64";
          hash = "sha256-XkaJWFA8YOlAsbGvP+IGTBb9FB8WBxEcr5nywKDoByU=";
        };
        aarch64-linux = {
          npm = "linux-arm64";
          hash = "sha256-Q5wN0NaSP2B7TlzR4wecEvC4b25QB/B+N31q0l4te7k=";
        };
        x86_64-linux = {
          npm = "linux-x64";
          hash = "sha256-VIGMufzjNgzG5Ez8WpaVLNXBJD77Q8vkiOEd2oRmPgg=";
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
          install -Dm755 package/vendor/*/bin/codex "$out/bin/codex"
          install -Dm755 package/vendor/*/bin/codex-code-mode-host "$out/bin/codex-code-mode-host"
        '';
  }
)
