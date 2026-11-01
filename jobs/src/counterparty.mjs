// Agent-side guard: the check an AI agent runs before it signs a payment, and the wrapper that refuses to
// sign when the answer is "block" or a human says no to a "warn".
//
// This is the first line. The vault (Mamori) is the last: even if an agent ignores every verdict here, its
// access key can only send within the 24 hour limit, to allowed recipients if the policy is on, and anything
// larger waits in a queue the admin can cancel. Both layers are needed: this one saves gas and tells the
// human why; the contract is the one that cannot be talked out of it.
const NO_CODE = "11111111111111111111111111111111";
const IMPLICIT = /^[0-9a-f]{64}$/;

/** @typedef {{ verdict: "allow" | "warn" | "block", reasons: { level: "info" | "warn" | "block", text: string }[] }} Verdict */

/**
 * @param rpc        from makeRpc
 * @param vault      the vault the agent pays from (its allowlist is read from the chain)
 * @param to         the recipient account
 * @param blocklist  Map<account, evidence> shared among agents; entries carry the reason they were reported
 * @param history    Set of recipients this agent has paid before
 * @returns Verdict. Every signal that was not checked says so: "could not check" is a warning, never a pass.
 */
export async function checkCounterparty({ rpc, vault, to, blocklist = new Map(), history = new Set() }) {
  const reasons = [];
  const add = (level, text) => reasons.push({ level, text });

  if (blocklist.has(to)) add("block", `reported as bad: ${blocklist.get(to)}`);

  let account;
  try {
    account = await rpc.account(to);
  } catch (e) {
    add("warn", `could not read the recipient account (${e.message ?? e})`);
  }
  if (account === null) {
    // An unfunded implicit account is a normal first payment; a named account that does not exist cannot receive.
    if (IMPLICIT.test(to)) add("warn", "this implicit account has never been funded");
    else add("block", "this account does not exist, so the transfer would fail");
  } else if (account) {
    const isContract = account.code_hash !== NO_CODE || Boolean(account.global_contract_hash);
    if (isContract) add("warn", "the recipient is a contract, not a person's account");
  }

  try {
    const policy = await rpc.view(vault, "allowlist");
    if (policy.enforced && !policy.accounts.includes(to)) add("block", "the vault only pays allowlisted recipients and this is not one");
    else if (!policy.enforced) add("info", "the vault has no recipient allowlist switched on");
  } catch (e) {
    add("warn", `could not read the vault's allowlist (${e.message ?? e})`);
  }

  if (!history.has(to)) add("warn", "this agent has never paid this recipient before");

  const verdict = reasons.some((r) => r.level === "block") ? "block" : reasons.some((r) => r.level === "warn") ? "warn" : "allow";
  return { verdict, reasons };
}

/**
 * Signs only if the verdict allows it. On "block" nothing is signed. On "warn" a human decides.
 * @param send     () => Promise<string>, signs and sends, returns the tx hash
 * @param confirm  (verdict) => Promise<boolean>, asks a human; absent means "no"
 */
export async function guardedSend({ check, send, confirm = async () => false, log = () => {} }) {
  const v = await check();
  log({ step: "check", verdict: v.verdict, reasons: v.reasons.map((r) => `${r.level}: ${r.text}`) });
  if (v.verdict === "block") return { sent: false, verdict: v.verdict, reasons: v.reasons };
  if (v.verdict === "warn" && !(await confirm(v))) return { sent: false, verdict: v.verdict, reasons: v.reasons, declined: true };
  const hash = await send();
  log({ step: "sent", hash });
  return { sent: true, verdict: v.verdict, reasons: v.reasons, hash };
}
