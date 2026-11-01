// `kaigen-jobs judge`: the reproducibility screen, as one command with a structured report.
//
// For every claim the project makes that can be checked on a laptop, it runs the command, records the exit
// code and the evidence line, and prints PASS or FAIL. A command that cannot run (a missing tool, no network)
// is reported as SKIPPED with the reason: never as a pass. `--testnet` adds the free on-chain rehearsal.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const run = (cmd, cwd) => spawnSync(cmd, { cwd, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60_000 });

const sum = (text, re) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);

/** The checks. `evidence` turns command output into the line a reader can verify; null means "no evidence found". */
export function checks(root) {
  const wasm = (d, f) => path.join(root, "out", d, f);
  return [
    {
      id: "contracts",
      claim: "Kizashi and Mamori behave as specified: signed claims, replay and theft resistance, the 24 h cap, delayed withdrawals, the allowlist, and a lockdown that retries failed key deletions",
      cmd: "cargo test --workspace",
      cwd: root,
      needs: "cargo",
      evidence: (o) => {
        const n = sum(o, /test result: ok\. (\d+) passed/g);
        return n > 0 && !/FAILED|failed;/.test(o.replace(/0 failed/g, "")) ? `${n} Rust tests passed` : null;
      },
    },
    {
      id: "omen-derivation",
      claim: "Omen keys derive from public seeds by hash-to-curve, and claim signatures match what the contract verifies",
      cmd: "node --test omens.test.mjs",
      cwd: path.join(root, "scripts"),
      evidence: (o) => (/ℹ fail 0/.test(o) ? `${sum(o, /ℹ pass (\d+)/g)} tests passed` : null),
    },
    {
      id: "jobs",
      claim: "The exposure index, keeper, watchers, fire test, verifier, counterparty check and injection demo each report failure when they should",
      cmd: "node --test test/*.test.mjs",
      cwd: path.join(root, "jobs"),
      evidence: (o) => (/ℹ fail 0/.test(o) ? `${sum(o, /ℹ pass (\d+)/g)} tests passed` : null),
    },
    {
      id: "app-types",
      claim: "The app typechecks",
      cmd: "npx tsc --noEmit",
      cwd: path.join(root, "app"),
      evidence: () => "tsc reported no errors",
    },
    {
      id: "app-units",
      claim: "The top-up amount parser never rounds a typo into a different amount",
      cmd: "npm test",
      cwd: path.join(root, "app"),
      evidence: (o) => (/ℹ fail 0/.test(o) ? `${sum(o, /ℹ pass (\d+)/g)} tests passed` : null),
    },
    {
      id: "production-build",
      claim: "The production wasm has no drill-only `reset` entry point, and the drill build does",
      run: () => {
        const exportsOf = (f) => (fs.existsSync(f) ? WebAssembly.Module.exports(new WebAssembly.Module(fs.readFileSync(f))).map((e) => e.name) : null);
        const prod = exportsOf(wasm("prod", "kizashi.wasm"));
        const drill = exportsOf(wasm("drill", "kizashi.wasm"));
        if (!prod || !drill) return { code: 1, out: "out/prod or out/drill wasm is missing; run `make build` first", skipped: true };
        const ok = !prod.includes("reset") && drill.includes("reset");
        return { code: ok ? 0 : 1, out: `prod exports reset: ${prod.includes("reset")}; drill exports reset: ${drill.includes("reset")}` };
      },
      evidence: (o) => o,
    },
    {
      id: "testnet-rehearsal",
      claim: "On a real chain: a post-quantum-only vault locks down its classical keys after an omen claim (both curves), a prompt-injected agent is stopped at every layer, and the admin can cancel a queued theft",
      cmd: "node jobs/src/bin.mjs testnet",
      cwd: root,
      optIn: "--testnet",
      evidence: (o) => (/RESULT: the lockdown and every attack defence worked/.test(o) ? o.split("\n").filter((l) => /^(PASS|HELD )/.test(l)).length + " checks held on testnet" : null),
    },
  ];
}

export async function judge({ root, withTestnet = false, log = () => {} }) {
  const results = [];
  for (const c of checks(root)) {
    if (c.optIn && !withTestnet) {
      results.push({ id: c.id, claim: c.claim, status: "SKIPPED", detail: `not run; add ${c.optIn} (free, uses throwaway testnet accounts)` });
      continue;
    }
    if (c.needs && run(`${c.needs} --version`, root).status !== 0) {
      results.push({ id: c.id, claim: c.claim, status: "SKIPPED", detail: `${c.needs} is not installed` });
      continue;
    }
    log({ running: c.id });
    const r = c.run ? c.run() : (() => { const x = run(c.cmd, c.cwd); return { code: x.status, out: `${x.stdout ?? ""}${x.stderr ?? ""}`, error: x.error }; })();
    if (r.skipped) {
      results.push({ id: c.id, claim: c.claim, status: "SKIPPED", detail: r.out });
      continue;
    }
    const evidence = r.code === 0 ? c.evidence(r.out) : null;
    results.push({
      id: c.id,
      claim: c.claim,
      command: c.cmd ?? "(built-in check)",
      status: r.code === 0 && evidence ? "PASS" : "FAIL",
      detail: evidence ?? (r.error ? String(r.error.message) : `exit ${r.code}: ${String(r.out).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`),
    });
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  return { ok: failed === 0, failed, skipped, results };
}

export function renderJudge(report) {
  const lines = [];
  for (const r of report.results) lines.push(`${r.status.padEnd(7)} ${r.id}\n          claim: ${r.claim}\n          ${r.command ? `command: ${r.command}\n          ` : ""}evidence: ${r.detail}`);
  lines.push("", report.ok ? `No check failed (${report.skipped} skipped, each with its reason above).` : `${report.failed} check(s) FAILED.`);
  return lines.join("\n");
}
