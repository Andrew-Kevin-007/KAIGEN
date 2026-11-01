// The text of `kaigen-jobs mainnet help`: the stage flow of docs/PLAN-submission-and-mainnet.md as the commands that
// implement it, the key file format, and the settings in deployments.json. Kept beside the tools so a change to one is
// seen next to the other; test/config.test.mjs checks it against deployments.example.json.

export const mainnetHelp = () => `KAIGEN mainnet tooling:  node jobs/src/bin.mjs mainnet <command>

Every command is a dry run until it is given its confirmation flag AND a key file. Nothing here creates or stores a key.

THE STAGES (docs/PLAN-submission-and-mainnet.md, section B)
  0  mainnet gates                              read-only checks of mainnet; needs only deployments.json
  1  mainnet plan                               prints every transaction of stages 1 to 3 and sends nothing
     mainnet execute --stage 1 --yes            the drill pair: drill Kizashi and drill vault(s), each deployed and
                                                initialised in ONE transaction. Signed as mainnet.deployer
     G1, by hand                                this tool does not run it. Sign the ML-DSA AddKey, then the DeleteKey of
                                                the classical key WITH THE ML-DSA KEY, then run the fire test
                                                (kaigen-jobs firetest). If G1 fails, stop: do not go on to stage 2
  2  mainnet execute --stage 2 --yes            the production Mamori reference (code only). Refuses until the chain
                                                shows each drill vault with an ML-DSA full-access key that has signed a
                                                transaction and no classical full-access key
  3  mainnet execute --stage 3 --yes            production Kizashi, deployed and initialised in ONE transaction, no key
                                                deleted. Signed by the Kizashi account's own key; the account must exist,
                                                be funded and be registered with the USDC token
  4  make verify-prelock                        = verify --release --pre-lock: two RPC hosts, one block, writes
                                                data/gates/release-gate-<time>.json (good for 24 hours)
  5  mainnet lock --i-understand-this-is-irreversible
                                                ONE transaction deleting every access key of Kizashi, then a post-check.
                                                Without the flag it re-reads and prints the keys and sends nothing. It
                                                acts on the newest gate file, or the one named with --gate <file>
  after the lock: make verify                   the same release check, now requiring no access keys on Kizashi

Stages 1 to 3 skip steps already on chain, so a stopped stage can be run again. Every step is appended to
data/mainnet/phase.log (ids, hashes and results; never keys or code).

THE KEY FILE (KAIGEN_DEPLOYER_KEY_FILE: the path of a JSON file outside the repo)
  { "account_id": "<the account the stage signs as>", "private_key": "<ed25519 private key>" }
  Stages 1 and 2 are signed as mainnet.deployer. Stage 3 and the lock are signed as the Kizashi account, and its key must
  be its own key: stage 3 and the lock refuse a key that is also on the deployer, the Mamori reference or a drill
  account, because the lock deletes the Kizashi key and a shared one would outlive it. The file is read only when a
  transaction is about to be sent, and its private key is never printed or logged.

deployments.json (copy deployments.example.json; the path can be set with KAIGEN_DEPLOYMENTS)
  rpc, rpcSecondary              two RPC hosts of DIFFERENT operators; release verification reads both and fails on any
                                 difference
  archivalRpc, archivalRpcSecondary   the same for archival reads (fire-test evidence)
  bountyYocto                    the bounty Kizashi must hold, a whole number of yoctoNEAR in a string; release
                                 verification fails without it
  kizashi, mamoriReference       the production accounts; stage 2 creates the reference as a sub-account of the deployer
  mainnet.deployer               the account that creates the drill pair and the reference; they are its sub-accounts
  mainnet.kizashiInit            { "omens": <the "omens" of: node scripts/omens.mjs derive>, "usdc": "<token account>" }
  mainnet.drillInit              { "omens": <the output of: node scripts/omens.mjs drill <secrets file>>, "usdc": null }
  mainnet.drillKeys              the drill public keys, the same array; never a secrets file
                                 (the three files above are paths relative to the repo root and hold public values only)
  mainnet.marginNear             optional, default 0.5: NEAR kept above each account's storage cost
  mainnet.minProtocol            optional, default 86: raises stage 0's protocol floor
  mainnet.drillVault             optional: { "dailyLimitYocto", "delaySecs" } for the drill vaults
  drill.kizashi, drill.vaults, drill.dailyKeys   the drill pair

make test, make build and make predeploy are described in the Makefile.
`;
