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

      # Every command is a TypeScript file that Node 24 runs as it is. A package is the same set of
      # files with some commands in bin/. The wrappers pin Node, and the installed files call
      # ssh-keygen, and fprintd-verify where it is given, by their full path in the store. So no
      # command depends on PATH for them.
      #   commands: the name of each command and the file that it runs.
      #   flags: more makeWrapper flags for a command.
      build =
        pkgs:
        {
          pname,
          description,
          commands,
          flags ? { },
          fprintd ? null,
        }:
        pkgs.stdenvNoCC.mkDerivation {
          inherit pname;
          version = "0.1.0";
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./src
              ./signer
              ./server
              ./package.json
            ];
          };
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/laws $out/bin
            cp -r src signer server package.json $out/lib/laws/
            substituteInPlace $out/lib/laws/signer/laptop.ts $out/lib/laws/src/approvals.ts \
              --replace-fail 'const SSH_KEYGEN = "ssh-keygen";' 'const SSH_KEYGEN = "${pkgs.openssh}/bin/ssh-keygen";'
            ${lib.optionalString (fprintd != null) ''
              substituteInPlace $out/lib/laws/signer/laptop.ts \
                --replace-fail 'const FPRINTD_VERIFY = "fprintd-verify";' 'const FPRINTD_VERIFY = "${fprintd}/bin/fprintd-verify";'
            ''}
            ${lib.concatStrings (
              lib.mapAttrsToList (name: file: ''
                makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/${name} --add-flags $out/lib/laws/${file} ${flags.${name} or ""}
              '') commands
            )}
            runHook postInstall
          '';
          meta = {
            inherit description;
            mainProgram = pname;
            platforms = lib.platforms.linux;
          };
        };

      # laws, the command. laws runs checks with "sh"; bash is put last on its PATH in case
      # there is none.
      lawsPackage =
        pkgs:
        build pkgs {
          pname = "laws";
          description = "Law cards with a check, a bite and a signed approval";
          commands = {
            laws = "src/cli.ts";
          };
          flags.laws = "--suffix PATH : ${lib.makeBinPath [ pkgs.bash ]}";
        };

      # The laptop's fingerprint helper. It needs the fprintd of the machine it runs on.
      signerdPackage =
        pkgs: fprintd:
        build pkgs {
          pname = "laws-signerd";
          description = "The laptop's fingerprint helper for the laws signing server";
          commands.laws-signerd = "signer/laptop.ts";
          inherit fprintd;
        };

      # The signing server with its page.
      serverPackage =
        pkgs:
        build pkgs {
          pname = "laws-server";
          description = "The laws signing server: it carries cards to your finger and signatures back";
          commands.laws-server = "server/server.ts";
        };

      # What both services share. Node compiles code while it runs, so MemoryDenyWriteExecute is left
      # out, and so is the "~@resources" filter: Node raises its own limit of open files when it starts.
      sandbox = {
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true; # no access to /home, /root and /run/user
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        RemoveIPC = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
        CapabilityBoundingSet = "";
        UMask = "0077";
      };

      fingers = [
        "left-thumb"
        "left-index-finger"
        "left-middle-finger"
        "left-ring-finger"
        "left-little-finger"
        "right-thumb"
        "right-index-finger"
        "right-middle-finger"
        "right-ring-finger"
        "right-little-finger"
      ];
    in
    {
      packages = forEachSystem (pkgs: {
        default = lawsPackage pkgs;
        laws-signerd = signerdPackage pkgs pkgs.fprintd;
        laws-server = serverPackage pkgs;
      });

      # The laptop's fingerprint helper as a service. It runs as root, because the laptop key must be
      # out of reach of every program that runs as you. It may use the network, to reach the signing
      # server, and it has no access to /home.
      #   socket  /run/laws-signer/socket   for the user's group: laws sign calls it
      #   key     /var/lib/laws-signer/key  made at the first start; key.pub lies next to it
      #   log     /var/lib/laws-signer/log
      nixosModules.laws-signer =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.laws-signer;
        in
        {
          options.services.laws-signer = {
            enable = lib.mkEnableOption "the laws fingerprint helper: it approves requests on the signing server after one named finger touched the reader";
            server = lib.mkOption {
              type = lib.types.strMatching "https://.+";
              example = "https://pi.example.ts.net/laws/";
              description = "The address of the signing server. The helper approves only requests that wait there.";
            };
            user = lib.mkOption {
              type = lib.types.str;
              example = "alex";
              description = "The user whose finger is asked for.";
            };
            finger = lib.mkOption {
              type = lib.types.enum fingers;
              example = "right-middle-finger";
              description = ''
                The one finger that approves, by the name that fprintd gives it. Enroll it for the user first
                (fprintd-enroll -f <finger>). Best a finger that unlocks nothing else.
              '';
            };
            group = lib.mkOption {
              type = lib.types.str;
              default = config.users.users.${cfg.user}.group;
              defaultText = lib.literalExpression "config.users.users.\${cfg.user}.group";
              description = "The group that may call the helper's socket. A call alone signs nothing.";
            };
            package = lib.mkOption {
              type = lib.types.package;
              default = signerdPackage pkgs config.services.fprintd.package;
              defaultText = lib.literalMD "laws-signerd, built with the fprintd of this machine";
              description = "The package with the laws-signerd command.";
            };
          };

          config = lib.mkIf cfg.enable {
            assertions = [
              {
                assertion = config.services.fprintd.enable;
                message = "services.laws-signer asks the fingerprint reader through fprintd: set services.fprintd.enable = true.";
              }
            ];
            systemd.services.laws-signer = {
              description = "laws fingerprint helper";
              wantedBy = [ "multi-user.target" ];
              after = [ "dbus.service" ];
              serviceConfig = sandbox // {
                ExecStart = lib.concatStringsSep " " [
                  "${cfg.package}/bin/laws-signerd"
                  "--socket /run/laws-signer/socket"
                  "--server ${cfg.server}"
                  "--key /var/lib/laws-signer/key"
                  "--log /var/lib/laws-signer/log"
                  "--user ${cfg.user}"
                  "--finger ${cfg.finger}"
                ];
                Restart = "on-failure";
                RestartSec = 5;
                # Root, with none of root's special powers. The group is that of the socket.
                User = "root";
                Group = cfg.group;
                StateDirectory = "laws-signer";
                StateDirectoryMode = "0700";
                RuntimeDirectory = "laws-signer";
                RuntimeDirectoryMode = "0750";
              };
            };
          };
        };

      # The signing server as a service. It listens on this machine only. A reverse proxy has to serve
      # it under a path of its own and remove that path before it passes a request on. That route is
      # not set here. With Caddy it looks like this:
      #   redir /laws /laws/
      #   handle_path /laws/* { reverse_proxy 127.0.0.1:<port> }
      nixosModules.laws-server =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.laws-server;
        in
        {
          options.services.laws-server = {
            enable = lib.mkEnableOption "the laws signing server";
            port = lib.mkOption {
              type = lib.types.port;
              example = 8102;
              description = "The port on 127.0.0.1 that the server listens on.";
            };
            origin = lib.mkOption {
              type = lib.types.strMatching "https://[^/]+";
              example = "https://pi.example.ts.net";
              description = "The web address under which the phone reaches the page, without a path.";
            };
            rpId = lib.mkOption {
              type = lib.types.str;
              default = lib.head (lib.splitString ":" (lib.removePrefix "https://" cfg.origin));
              defaultText = lib.literalMD "the host name in `origin`";
              description = "The site that passkeys are made for: the host name of the origin, or a parent of it.";
            };
            signersFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              example = "/etc/laws/allowed_signers";
              description = ''
                A copy of the signers file. With it the server checks each signature before it stores it, so
                that the phone hears at once whether the laptop will accept it. Nothing depends on this check.
              '';
            };
            package = lib.mkOption {
              type = lib.types.package;
              default = serverPackage pkgs;
              defaultText = lib.literalMD "laws-server";
              description = "The package with the laws-server command.";
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.laws-server = {
              description = "laws signing server";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" ];
              serviceConfig = sandbox // {
                ExecStart = lib.concatStringsSep " " (
                  [
                    "${cfg.package}/bin/laws-server"
                    "--listen 127.0.0.1:${toString cfg.port}"
                    "--state /var/lib/laws-server"
                    "--origin ${cfg.origin}"
                    "--rp-id ${cfg.rpId}"
                  ]
                  ++ lib.optional (cfg.signersFile != null) "--signers ${cfg.signersFile}"
                );
                Restart = "on-failure";
                # A throwaway user with its own data folder, read-only everywhere else.
                DynamicUser = true;
                PrivateUsers = true;
                StateDirectory = "laws-server";
                StateDirectoryMode = "0700";
              };
            };
          };
        };

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

        # The installed commands start and find their files. They are run with an empty environment:
        # each must find ssh-keygen without PATH. laws sign must refuse when it has no signing server,
        # the helper must refuse "any" finger and make its key, and the server must come up.
        package =
          let
            laws = lawsPackage pkgs;
            signerd = signerdPackage pkgs pkgs.fprintd;
            server = serverPackage pkgs;
            helper = "--socket socket --server https://pi.example.ts.net/laws/ --key helper-key --log helper-log --user alex";
          in
          pkgs.runCommand "laws-package" { } ''
            ${laws}/bin/laws show T-01 --repo ${self} | grep "^id: T-01$" > /dev/null
            (env -i ${laws}/bin/laws sign --repo ${self} 2>&1 || true) | grep "no signer: pass --server" > /dev/null

            (env -i ${signerd}/bin/laws-signerd ${helper} --finger any 2>&1 || true) | grep "refused on purpose" > /dev/null
            test ! -e helper-key
            (env -i ${pkgs.coreutils}/bin/timeout 5 ${signerd}/bin/laws-signerd ${helper} --finger right-index-finger 2>&1 || true) \
              | grep "listening on socket" > /dev/null
            test -s helper-key.pub
            grep -F 'const FPRINTD_VERIFY = "${pkgs.fprintd}/bin/fprintd-verify";' ${signerd}/lib/laws/signer/laptop.ts > /dev/null
            test -x ${pkgs.fprintd}/bin/fprintd-verify

            (env -i ${pkgs.coreutils}/bin/timeout 5 ${server}/bin/laws-server --listen 127.0.0.1:0 --state state \
              --origin https://pi.example.ts.net --rp-id pi.example.ts.net 2>&1 || true) | grep "listening on 127.0.0.1:" > /dev/null
            test -d state
            touch $out
          '';

        # The two modules evaluate, and the services get the settings that were asked for. Nothing is
        # built or started here.
        modules =
          let
            machine = nixpkgs.lib.nixosSystem {
              modules = [
                self.nixosModules.laws-signer
                self.nixosModules.laws-server
                {
                  nixpkgs.hostPlatform = pkgs.stdenv.hostPlatform.system;
                  services.fprintd.enable = true;
                  users.users.alex.isNormalUser = true;
                  services.laws-signer = {
                    enable = true;
                    server = "https://pi.example.ts.net/laws/";
                    user = "alex";
                    finger = "right-middle-finger";
                  };
                  services.laws-server = {
                    enable = true;
                    port = 8102;
                    origin = "https://pi.example.ts.net";
                    signersFile = "/etc/laws/allowed_signers";
                  };
                }
              ];
            };
            helper = machine.config.systemd.services.laws-signer.serviceConfig;
            server = machine.config.systemd.services.laws-server.serviceConfig;
            has = text: unit: lib.hasInfix text unit.ExecStart;
          in
          assert has "/bin/laws-signerd --socket /run/laws-signer/socket --server https://pi.example.ts.net/laws/ " helper;
          assert has " --key /var/lib/laws-signer/key --log /var/lib/laws-signer/log --user alex --finger right-middle-finger" helper;
          assert helper.User == "root" && helper.Group == "users" && helper.CapabilityBoundingSet == "";
          assert helper.ProtectHome == true && helper.ProtectSystem == "strict" && !(helper ? DynamicUser);
          assert has "/bin/laws-server --listen 127.0.0.1:8102 --state /var/lib/laws-server " server;
          assert has " --origin https://pi.example.ts.net --rp-id pi.example.ts.net --signers /etc/laws/allowed_signers" server;
          assert server.DynamicUser == true && server.ProtectHome == true && server.StateDirectory == "laws-server";
          pkgs.runCommand "laws-modules" { } "touch $out";
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
