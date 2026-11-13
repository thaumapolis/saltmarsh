{
  description = "Saltmarsh: manage a tidal pool, one self-contained HTML file";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # Golden images and browser assertions run in one browser process, so a
      # baseline only means the same pixels on the same system. Only
      # x86_64-linux is exercised.
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.playwright-driver
            pkgs.git
            pkgs.python3
          ];

          env = {
            # ESM ignores NODE_PATH, so the driver is addressed by absolute path.
            PLAYWRIGHT_ENTRY = "${pkgs.playwright-driver}/index.mjs";
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          };

          shellHook = ''
            echo "saltmarsh: ./check.sh   (build, artifact guarantees, model, browser, iframe)"
          '';
        };
      });

      packages = forAllSystems (pkgs: {
        # The artifact alone. Anything other than exactly index.html means the
        # bundler started emitting siblings, which breaks the single-file promise.
        default = pkgs.runCommand "saltmarsh"
          {
            src = ./.;
            nativeBuildInputs = [ pkgs.nodejs_22 ];
          }
          ''
            node "$src/tools/build.mjs" "$out/index.html"
            test -s "$out/index.html"

            # Self-contained: no external asset references. Bare in-page
            # fragments (#) and inline data: URIs are the only allowed values.
            ! grep -qE '<(script|link|img|source|iframe)[^>]+(src|href)="[^#d]' "$out/index.html" \
              || { echo "artifact references an external file"; exit 1; }

            # A storage dependency would throw inside a sandboxed opaque-origin
            # iframe, so the artifact must not ask for one.
            ! grep -qE 'localStorage|sessionStorage|indexedDB|document\.cookie' "$out/index.html" \
              || { echo "artifact references web storage"; exit 1; }
          '';
      });
    };
}
