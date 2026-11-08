// Reads an account to find out whether it is a Mamori vault, for the onboarding step. It asks for the same four views
// the vault page reads and judges the answers with vaultShapeProblem, so "is a vault" means the same thing in both.
import type { ProbeResult } from "./onboarding.ts";
import { hasContract, rpcNetworkProblem, view } from "./near.ts";
import { errorText } from "./errors.ts";
import { isMissingView, vaultShapeProblem } from "./vault-shape.ts";

/**
 * `none` only for a definite answer: no contract on the account, a contract without the vault's views, or views whose
 * answers are not the vault's shape. Anything else that goes wrong (network, RPC, wrong network) is `error`: unknown.
 */
export async function probeVault(id: string, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const wrongNetwork = await rpcNetworkProblem(signal);
    if (wrongNetwork) return { ok: false, kind: "error", message: wrongNetwork };
    if (!(await hasContract(id, signal))) return { ok: false, kind: "none", message: "No contract is deployed on that account, so it is not a vault." };
    const [config, keys, queue, spent] = await Promise.all([
      view<unknown>(id, "config", {}, signal),
      view<unknown>(id, "daily_keys", {}, signal),
      view<unknown>(id, "queue", {}, signal),
      view<unknown>(id, "spent_24h", { token: null }, signal),
    ]);
    const problem = vaultShapeProblem({ config, keys, queue, spent });
    return problem ? { ok: false, kind: "none", message: problem } : { ok: true };
  } catch (e) {
    if (isMissingView(e)) return { ok: false, kind: "none", message: "That contract does not have a vault's views, so it is not a vault." };
    return { ok: false, kind: "error", message: errorText(e, "That account could not be read.") };
  }
}
