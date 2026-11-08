// The walkthrough text. Every claim and number here is taken from a measured document in this repository and the
// document is named in `source`. Nothing is added from memory or from the product pitch. Words that claim more than
// the evidence ("novel", "first", "unique", "unbreakable") and comparisons with other projects stay out; the test in
// onboarding-content.test.ts checks that. Testnet only, no audit, never run on mainnet.

export interface WalkthroughStep {
  id: string;
  title: string;
  paragraphs: string[];
  /** Shell commands, shown as given in the source document. */
  commands?: string[];
  /** The repository files this step is read from. */
  source: string;
}

export const CAVEATS = [
  "Testnet only.",
  "No audit.",
  "Not run on mainnet.",
  "The omens in the demo Kizashi are drill omens: nothing here means a production key has broken.",
];

export const WALKTHROUGH: WalkthroughStep[] = [
  {
    id: "era",
    title: "What the era means",
    paragraphs: [
      "The era has three values: Calm, Warning and Kaigen. In Calm the vault works as configured. When the era is Warning or Kaigen, send_small refuses with \"paused: era is not calm\", and execute refuses too.",
      "A Warning freezes the withdrawal queue. At Kaigen the vault's lock_down discards the queue and works through the daily keys it records; if any are left it logs lockdown_partial with how many.",
      "On testnet the omens are drill omens that belong to the project, so an era change there is a rehearsal. Everything on this site is test data.",
    ],
    source: "docs/v3/ATTEST-CHECK.md (reason codes, events), docs/v3/STRETCH-DESIGN.md (D14), docs/v3/TESTNET-REHEARSAL.md",
  },
  {
    id: "daily-key",
    title: "The agent's daily key and the three-strike burn",
    paragraphs: [
      "A daily key is a classical function-call key that can call two methods on the vault: send_small and request_withdraw. Only a recorded daily key can move value.",
      "A refusal that is a strike counts against the key: sending to a payee not on the allowlist, or sending more than the whole 24 hour limit. Other refusals, such as another key having used up today's room, are not strikes, so one key cannot burn another. With 3 strikes allowed, the vault deletes the key on the third.",
      "In the testnet rehearsal of 2026-11-04 the key was burned on attack 3, the burned key was refused afterwards, and nothing reached the attacker. That ran on a drill build of the vault.",
      "The strike counter catches a clumsy attacker only. Anyone can read the exact headroom with the free check view, and a call that sends exactly the headroom is never refused and never struck. What holds then is the loss bound in the next step.",
    ],
    source: "docs/v3/ATTEST-CHECK.md (sections 3.3, 4), docs/v3/LOSS-BOUND.md (E6, E9), docs/v3/TESTNET-REHEARSAL.md, docs/v3/ATTACK-RESULTS.md (attacks 1 and 9)",
  },
  {
    id: "queue",
    title: "The withdrawal queue and the 24 hour delay",
    paragraphs: [
      "A larger send goes through request_withdraw into a queue. It can be executed only after the withdrawal delay, and the admin can cancel it until then. A production build refuses a delay under 86,400 seconds (24 hours).",
      "What a daily key can lose in any 24 hour window is at most the 24 hour cap C plus the pending limit P, when the delay is at least 24 hours. The default pending limit is 10 times the cap. On a local sandbox with a cap of 1 NEAR, a calibrated attacker lost 1 NEAR (one cap, zero strikes) over 21 blocks, and 11 NEAR in one 24 hour window with nobody cancelling, which is C + P.",
      "The bound is per window, not per lifetime: a drain repeated every day is not limited by it. The queue part of the bound (P) assumes the admin looks at least once per delay period; without that, the whole queue part can execute.",
      "The testnet vault from the rehearsal is a drill build with a 10 second delay. Do not read a 24 hour lock into a testnet vault.",
    ],
    source: "docs/v3/LOSS-BOUND.md (sections 1, 3), docs/v3/ATTACK-RESULTS.md (attack 2), docs/v3/DEMO-SCRIPT.md (section 0)",
  },
  {
    id: "cage-check",
    title: "What cage-check verifies",
    paragraphs: [
      "cage-check reads the vault's access keys from the RPC and compares them with what the vault records about itself in attest(). It reports red when it finds a classical full-access key, or anything other than exactly one ML-DSA full-access key; a function-call key with no allowance or the wrong methods; a key the vault does not record; a recorded intents.near key; or code that differs from a pinned hash.",
      "attest() is the vault's own statement. It is not proof about the account, because a full-access key can deploy code whose attest() says anything. That is why the keys and the code hash are read from the chain.",
      "Measured on a local sandbox with a stand-in admin key (not a production result): a planted full-access key turned it red and removing the key turned it green. The checker marks a drill build red (row ATTEST-2) on purpose, so a drill vault on testnet is expected to read red.",
    ],
    commands: ["node jobs/src/bin.mjs cage-check <vault> --rpc https://rpc.testnet.fastnear.com"],
    source: "docs/v3/ATTEST-CHECK.md (sections 1, 2), docs/v3/ATTACK-RESULTS.md (attack 8), docs/v3/DEMO-SCRIPT.md (sections 2, 3)",
  },
  {
    id: "not-covered",
    title: "What is not covered",
    paragraphs: [
      "The loss bound does not cover: a drain repeated across many windows, compromise of the admin or cold key, or balances held on intents.near. Gas allowances sit outside the cap, and the strike counter does not stop a calibrated attacker.",
      "The bound is an argument backed by property tests, not a machine-checked proof. The attack numbers come from one local sandbox with a stand-in admin key. The policy-key split and sweep_to_safe ran in unit tests only, not on a chain.",
      "No audit has been done and nothing has run on mainnet. The testnet rehearsal deployed drill builds, not the production builds.",
    ],
    source: "docs/v3/LOSS-BOUND.md (sections 1, 3, 4), docs/v3/ATTACK-RESULTS.md (header), docs/v3/STRETCH-DESIGN.md (section 4), docs/v3/TESTNET-REHEARSAL.md (Not covered)",
  },
  {
    id: "cli",
    title: "What you do from the command line, not here",
    paragraphs: [
      "This page and the vault view only read. They do not add a daily key, set limits, edit the allowlist, or sign admin actions with the ML-DSA key. Those are admin calls, and this site has no screen for them.",
      "The jobs tool in this repository runs the testnet rehearsal, the scripted-agent demo and the read-only cage check. Run them from the repository root; docs/v3/DEMO-SCRIPT.md section 3 lists the environment each one needs.",
    ],
    commands: ["node jobs/src/bin.mjs testnet", "node jobs/src/bin.mjs demo", "node jobs/src/bin.mjs cage-check <vault> --rpc https://rpc.testnet.fastnear.com"],
    source: "docs/v3/DEMO-SCRIPT.md (sections 3, 7), jobs/src/bin.mjs usage",
  },
];
