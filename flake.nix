{
  description = "laws: law cards for software that agents write, with approvals locked by a signature";

  # nixpkgs is not pinned and there is no flake.lock. To use the system's nixpkgs:
  #   nix flake check --override-input nixpkgs nixpkgs --no-write-lock-file
  inputs.nixpkgs.url = "nixpkgs";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      forEachSystem = perSystem: lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (system: perSystem nixpkgs.legacyPackages.${system});

      # Both commands are TypeScript files that Node 24 runs as they are. The wrappers pin Node and
      # put OpenSSH's ssh-keygen first on the PATH.
      lawsPackage =
        pkgs:
        pkgs.stdenvNoCC.mkDerivation {
          pname = "laws";
          version = "0.1.0";
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./src
              ./signer
              ./package.json
            ];
          };
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontConfigure = true;
          dontBuild = true;
          installPhase =
            let
              wrap = name: file: ''
                makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/${name} \
                  --add-flags $out/lib/laws/${file} \
                  --prefix PATH : ${lib.makeBinPath [ pkgs.openssh ]} \
                  --suffix PATH : ${lib.makeBinPath [ pkgs.bash ]}
              '';
            in
            ''
              runHook preInstall
              mkdir -p $out/lib/laws $out/bin
              cp -r src signer package.json $out/lib/laws/
              ${wrap "laws" "src/cli.ts"}
              ${wrap "laws-signer" "signer/signer.ts"}
              runHook postInstall
            '';
          meta = {
            description = "Law cards with a check, a bite and a signed approval";
            mainProgram = "laws";
            platforms = lib.platforms.linux;
          };
        };
    in
    {
      packages = forEachSystem (pkgs: {
        default = lawsPackage pkgs;
      });

      checks = forEachSystem (pkgs: {
        typecheck = pkgs.runCommand "laws-typecheck" { nativeBuildInputs = [ pkgs.typescript ]; } ''
          cd ${self}
          tsc --noEmit
          touch $out
        '';

        # Every test except the bites, then "laws bite" on this repository's own cards:
        # a bite test is meant to fail, and "laws bite" passes only if every one of them does.
        tests =
          pkgs.runCommand "laws-tests"
            {
              nativeBuildInputs = [
                pkgs.nodejs_24
                pkgs.openssh
              ];
            }
            ''
              cp -r ${self} repo
              chmod -R u+w repo
              cd repo
              export HOME=$TMPDIR/home
              mkdir -p $HOME
              node --test --test-concurrency=4 "test/**/!(*.bite).test.ts"
              node src/cli.ts bite
              touch $out
            '';

        # The installed commands start and find their files.
        package = pkgs.runCommand "laws-package" { } ''
          ${lawsPackage pkgs}/bin/laws show T-01 --repo ${self} | grep "^id: T-01$" > /dev/null
          (${lawsPackage pkgs}/bin/laws-signer 2>&1 || true) | grep "usage: laws-signer" > /dev/null
          touch $out
        '';
      });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_24
            pkgs.openssh
            pkgs.typescript
          ];
        };
      });
    };
}
