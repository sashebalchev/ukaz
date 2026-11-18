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

      # Both commands are TypeScript files that Node 24 runs as they are. The wrappers pin Node, and the
      # installed files call ssh-keygen by its full path in the store, so neither command depends on PATH
      # for it. laws runs checks with "sh"; bash is put last on its PATH in case there is none.
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
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/laws $out/bin
            cp -r src signer package.json $out/lib/laws/
            substituteInPlace $out/lib/laws/signer/signer.ts $out/lib/laws/src/approvals.ts \
              --replace-fail 'const SSH_KEYGEN = "ssh-keygen";' 'const SSH_KEYGEN = "${pkgs.openssh}/bin/ssh-keygen";'
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/laws \
              --add-flags $out/lib/laws/src/cli.ts \
              --suffix PATH : ${lib.makeBinPath [ pkgs.bash ]}
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/laws-signer \
              --add-flags $out/lib/laws/signer/signer.ts
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

        # The installed commands start and find their files. The signer is run with an empty
        # environment: it must find ssh-keygen without PATH, and with no terminal it must refuse.
        package = pkgs.runCommand "laws-package" { } ''
          ${lawsPackage pkgs}/bin/laws show T-01 --repo ${self} | grep "^id: T-01$" > /dev/null
          ${pkgs.openssh}/bin/ssh-keygen -q -t ed25519 -N "" -C throwaway -f key
          mkdir out
          (env -i ${lawsPackage pkgs}/bin/laws-signer --repo ${self} --key key --log log --out out T-01 2>&1 || true) \
            | grep "there is no terminal" > /dev/null
          grep "refused:no-terminal T-01=" log > /dev/null
          test ! -e out/manifest.sig
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
