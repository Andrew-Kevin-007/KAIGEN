# Submission checklist (owner: Kevin only)

Status: 2026-11-07 (stretch items built; numbers refreshed). For Kevin only. Sources: docs/v3/ROADMAP.md and docs/PLAN-submission-and-mainnet.md.

## Rules that apply

- Only Kevin holds funded mainnet keys, moves funds, posts and submits. Claude Code does not. [ROADMAP.md section 1 rules; PLAN section D]
- Claude Code does not enter keys or run G1. Kevin runs `mainnet execute` and `mainnet lock` himself. [ROADMAP.md section 3, mainnet rule]
- A testnet-proven submission is eligible. A missed mainnet gate costs polish, not the submission. [PLAN ground rule 2]
- Window closes Sat 14 Nov 2026 23:59 UTC. Aim for Fri 13 Nov. Exams run 11 to 20 Nov. From 11 Nov, do only the README read, the demo check, the X post and the submit. [PLAN section A]

## Checklist (in order)

- [ ] **1. Run the zero-key harness.**
  - Who: Kevin.
  - Command: see that file (`docs/internal/V3-OPEN-CYBORG-PROGRESS.md` is not in the repo).
  - Done when: a zero-key Kizashi run is recorded in a fire-test file, and a third-party claim still works. [PLAN section A, Tue 3 Nov; PLAN section B stage 4 item 2]. Status: `zerokey` passed in both rehearsal runs [TESTNET-REHEARSAL.md]; the fire-test record was not checked here.

- [ ] **2. Review the UNVERIFIED README claims.**
  - Who: Kevin.
  - Command: none.
  - Done when: each item in `docs/v3/CHANGES-V2-TO-V3.md` section 6 is either sourced or removed from `README.md`, and its UNVERIFIED comment is gone. [CHANGES-V2-TO-V3.md section 6]

- [ ] **3. Real Mamori publish on testnet (M6, hash-pinned global contract).**
  - Who: Kevin, with one funded testnet account. No owner decision is needed to build; the tooling is built.
  - Command: `node jobs/src/bin.mjs globalcontract --kizashi <KIZASHI_ACCOUNT> --funder-file <FUNDER_FILE>` (dry run), then add `--yes`. [GLOBAL-CONTRACT.md section 4]
  - Done when: the real Mamori publish is recorded, which needs about 44.8 NEAR on one testnet account (an estimate: about 43.3 NEAR burnt for 432,906 bytes at 1e20 yocto per byte, plus 1 NEAR for the vault and a 0.5 NEAR margin; see GLOBAL-CONTRACT.md section 4). If it is not wanted, state it as not run. [GLOBAL-CONTRACT.md sections 4 and 6a; ROADMAP.md section 2, M6 row]

- [ ] **4. Decide the stretch items (policy-key split, `sweep_to_safe`, sentinel).**
  - Who: Kevin.
  - Command: none.
  - Done when: each item is written in `docs/v3/ROADMAP.md` section 2 as built or as "document as not applicable". The stretch items are built (commit cb62c80). On 2026-11-07 the owner ran `stretchdrill` on a testnet drill vault: `sweep_to_safe` and the policy path worked on the chain. The watcher path, a NEP-141 sweep and three of the four `propose_*` methods did not run on a chain [TESTNET-REHEARSAL.md, third run]. Record them in ROADMAP section 2 as built. The fallback tag `v3-core-testnet` is the build without them. The design choices for the safe account and watchers (Q5) are recorded in `docs/v3/STRETCH-DESIGN.md` once it is final. [ROADMAP.md sections 2 and 4]

- [ ] **5. Decide whether the peer comparison is wanted.**
  - Who: Kevin.
  - Command: none.
  - Done when: either Leash and near-agent-spend-guard are run with the same attack scripts, or the comparative wording is removed from `README.md`, `docs/v3/LANDSCAPE.md` and `docs/v3/NOVELTY-CLAIMS.md`. Then update gate E5 in `docs/v3/ROADMAP.md`. Today, LANDSCAPE.md and NOVELTY-CLAIMS.md still name both guards. [ROADMAP.md M9 and E5; NOVELTY-CLAIMS.md section 5 item 2]

- [ ] **6. Mainnet gates G1 and G2 (optional, never under time pressure).**
  - Who: Kevin, with his own keys.
  - Command: G1: `mainnet execute` (dry-run by default, `jobs/src/mainnet.mjs`). G2: none.
  - Done when: G1 has transaction links for AddKey, DeleteKey, deploy and the classical key delete on protocol 86, using a throwaway account. G2 has a publish result and its real cost. Confirm ML-DSA activation by RPC status before any mainnet statement. If this cannot be done calmly, skip it. [ROADMAP.md section 3; PLAN section B stage 1]

- [ ] **7. Record the demo.**
  - Who: Kevin.
  - Command: none.
  - Done when: a recording exists and runs under 90 seconds. The demo runs attack 2, then attack 1, then attack 8. [ROADMAP.md Q1; ARCHITECTURE.md, demo paragraph]. docs/v3/DEMO-SCRIPT.md is in the repo.

- [ ] **8. Submit.**
  - Who: Kevin. He presses submit and posts on X.
  - Command: none.
  - Done when: the submission confirmation is saved. Aim Fri 13 Nov 2026. Hard close Sat 14 Nov 2026 23:59 UTC. [PLAN section A, Wed 11 to Fri 13 Nov; ROADMAP.md section 1 item 9]

Not on this list: the Kizashi lock (PLAN stage 5). It is an irreversible step and is never done under time pressure. [PLAN ground rule 1]
