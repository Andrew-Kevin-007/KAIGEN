"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { WalletError } from "@/components/WalletError";
import { describedBy } from "@/lib/aria";
import { accessKeys } from "@/lib/near";
import { NETWORK } from "@/lib/network";
import {
  TEMP_KEY_GONE_AT,
  VAULT_CREATE_ENABLED,
  adminKeyFromBackupText,
  adminKeyFromHash,
  begin,
  fail,
  finalKeysError,
  finish,
  fundingYocto,
  initialSteps,
  nextStep,
  outcomeFailure,
  placeCaption,
  recoveryNote,
  stepCaption,
  txHashOf,
  txUrl,
  vaultAccountId,
  type StepId,
  type StepState,
  type StepStatus,
} from "@/lib/vault-create";
import { useWallet } from "@/lib/wallet";

type Signer = ReturnType<typeof import("@fastnear/api").utils.signerFromPrivateKey>;

const STEP_TEXT: Record<StepId, { title: string; detail: string }> = {
  create: { title: "Create and fund the account", detail: "Your wallet creates the vault account, sends it the funds, and gives it a temporary key made in this tab." },
  admin: { title: "Add the admin key", detail: "The temporary key adds your post-quantum admin key. The vault pays the gas from the funds you sent." },
  cleanup: { title: "Remove the temporary key", detail: "The temporary key deletes itself, leaving only your admin key." },
  check: { title: "Check the result", detail: "Reads the vault's keys from the chain. Only your admin key should be left." },
};
const STATUS_TEXT: Record<StepStatus, string> = { todo: "Waiting", running: "Running", done: "Done", failed: "Failed" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The three panels on this page. Their captions are counted from this list, and the steps inside the last one from the real step list.
const PARTS = ["admin", "account", "steps"] as const;
const partCaption = (part: (typeof PARTS)[number]) => placeCaption("Part", PARTS.indexOf(part), PARTS.length);

export default function CreateVaultPage() {
  return (
    <div className="container page">
      <div className="reading">
      <header className="page-head">
        <h1>Create the vault account</h1>
        <p className="lead">
          Your wallet creates the account. A temporary key made in this tab adds your post-quantum admin key and then deletes itself, so the vault ends up with that one key.
        </p>
      </header>
      {VAULT_CREATE_ENABLED ? (
        <Flow />
      ) : (
        <div className="callout" data-tone="warning">
          <strong>Not wired up yet.</strong>
          <span>
            Creating the vault needs the on-chain checks for post-quantum keys (gates G1 and G3) to pass on mainnet first, so this is switched off instead of pretending.
          </span>
        </div>
      )}
      </div>
    </div>
  );
}

function Flow() {
  const wallet = useWallet();
  const [admin, setAdmin] = useState<{ key: string; handle: string } | null>(null);
  const [adminError, setAdminError] = useState("");
  const [label, setLabel] = useState("");
  const [funding, setFunding] = useState("0.1");
  const [steps, setSteps] = useState<StepState[]>(initialSteps);
  const [tempPub, setTempPub] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  // The temporary key's secret lives only here: never stored, never sent anywhere but into a signature.
  const temp = useRef<{ publicKey: string; signer: Signer } | null>(null);

  async function acceptKey(raw: string | null) {
    if (!raw) {
      setAdmin(null);
      setAdminError("That is not a KAIGEN admin key.");
      return;
    }
    try {
      const { decodePublicKey, publicKeyToHandle } = await import("@fastnear/ml-dsa-65");
      decodePublicKey(raw); // throws unless it is a whole ML-DSA-65 public key
      setAdmin({ key: raw, handle: publicKeyToHandle(raw) });
      setAdminError("");
    } catch {
      setAdmin(null);
      setAdminError("That is not a valid ML-DSA-65 public key.");
    }
  }

  // The backup file holds only the public key in the clear. A file that cannot be read (moved or deleted after it was
  // picked, or refused by the browser) is said so, not left as a silent rejection.
  async function chooseBackup(file: File | undefined) {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setAdmin(null);
      setAdminError("That file could not be read. Choose it again.");
      return;
    }
    await acceptKey(adminKeyFromBackupText(text));
  }

  // The Protect page links here with the public key in the fragment.
  useEffect(() => {
    const fromLink = window.location.hash ? adminKeyFromHash(window.location.hash) : undefined;
    if (fromLink !== undefined) void acceptKey(fromLink);
  }, []);

  useEffect(
    () => () => {
      temp.current = null;
    },
    [],
  );

  // While the temporary key still controls the vault, leaving this tab would strand it.
  const tempLive = Boolean(tempPub) && steps[TEMP_KEY_GONE_AT - 1].status !== "done";
  useEffect(() => {
    if (!tempLive) return;
    const hold = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [tempLive]);

  const vault = wallet.account ? vaultAccountId(label, wallet.account) : null;
  const yocto = fundingYocto(funding);
  const nameBad = Boolean(label) && vault !== null && !vault.ok;
  const fundingBad = Boolean(funding) && yocto === null;
  const locked = steps[0].status !== "todo";
  const next = nextStep(steps);
  const note = vault?.ok ? recoveryNote(steps, vault.id, tempPub || "not made yet") : null;
  const ready = admin !== null && (next !== "create" || (wallet.account !== null && vault?.ok === true && yocto !== null));

  async function tempKey() {
    if (temp.current) return temp.current;
    const { utils } = await import("@fastnear/api");
    const secret = utils.privateKeyFromRandom("ed25519");
    temp.current = { publicKey: utils.publicKeyFromPrivate(secret), signer: utils.signerFromPrivateKey(secret) };
    setTempPub(temp.current.publicKey);
    return temp.current;
  }

  // The wallet may report the first transaction before every node sees it, so wait briefly for the key.
  async function waitForTempKey(id: string, publicKey: string) {
    for (let i = 0; i < 8; i++) {
      try {
        if ((await accessKeys(id)).some((k) => k.public_key === publicKey)) return;
      } catch {
        // The account may not be visible yet.
      }
      await sleep(1500);
    }
    throw new Error("The vault does not show the temporary key yet. Try this step again in a moment.");
  }

  async function runStep(id: StepId, vaultId: string): Promise<string | null> {
    if (!admin) throw new Error("Choose your admin key first.");
    const api = await import("@fastnear/api");
    if (id === "create") {
      if (yocto === null) throw new Error("Enter at least 0.05 NEAR to fund the vault.");
      const t = await tempKey();
      const outcome = await wallet.sendTx(vaultId, [api.actions.createAccount(), api.actions.transfer(yocto), api.actions.addFullAccessKey({ publicKey: t.publicKey })]);
      const failure = outcomeFailure(outcome);
      if (failure) throw new Error(failure);
      return txHashOf(outcome);
    }
    if (id === "check") {
      const problem = finalKeysError(await accessKeys(vaultId), admin.handle, tempPub);
      if (problem) throw new Error(problem);
      return null;
    }
    const t = temp.current;
    if (!t) throw new Error("This tab no longer holds the temporary key. Use your admin key to finish; see the note below.");
    if (id === "admin") await waitForTempKey(vaultId, t.publicKey);
    const action = id === "admin" ? api.actions.addFullAccessKey({ publicKey: admin.key }) : api.actions.deleteKey({ publicKey: t.publicKey });
    const outcome = await api.sendTx({ signer: t.signer, signerId: vaultId, receiverId: vaultId, actions: [action], waitUntil: "FINAL", network: NETWORK });
    const failure = outcomeFailure(outcome);
    if (failure) throw new Error(failure);
    if (id === "cleanup") temp.current = null;
    return txHashOf(outcome);
  }

  async function run(id: StepId) {
    if (!vault?.ok || busy) return;
    setError("");
    let current: StepState[];
    try {
      current = begin(steps, id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setSteps(current);
    setBusy(true);
    try {
      setSteps(finish(current, id, await runStep(id, vault.id)));
    } catch (e) {
      setSteps(fail(current, id, e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  // After a wallet popup closed at the wrong moment: if the account is on-chain with this tab's temporary key, step 1 did happen.
  async function reconcile() {
    if (!vault?.ok || !temp.current) return;
    setBusy(true);
    setError("");
    try {
      const have = (await accessKeys(vault.id)).some((k) => k.public_key === temp.current?.publicKey);
      if (!have) throw new Error("The account does not exist yet, or does not carry this tab's temporary key.");
      setSteps(finish(begin(steps, "create"), "create"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const failedCreate = steps[0].status === "failed";

  const nextIndex = next ? steps.findIndex((s) => s.id === next) : -1;
  const startNext = () => {
    if (!next) return;
    // The first step moves funds, so it is confirmed first.
    if (next === "create") setConfirm(true);
    else void run(next);
  };

  return (
    <div className="stack-lg">
      <section className="panel" aria-labelledby="admin-h">
        <p className="caption">{partCaption("admin")}</p>
        <h2 id="admin-h">Admin key</h2>
        {admin ? (
          <div className="field-group">
            <span className="label">Public key handle, to compare with the one on the Migrate page</span>
            <p className="mono">{admin.handle}</p>
          </div>
        ) : (
          <p className="body">Open this page from the Migrate page, or choose the backup file you saved. Only its public key is read.</p>
        )}
        <div className="field-group">
          <label className="label" htmlFor="backup-file">
            Backup file
          </label>
          <input
            id="backup-file"
            className="field"
            type="file"
            accept="application/json,.json"
            disabled={locked}
            aria-invalid={Boolean(adminError)}
            aria-describedby={describedBy(adminError && "backup-error")}
            onChange={(e) => void chooseBackup(e.target.files?.[0])}
          />
          {adminError && (
            <span id="backup-error" className="hint error">
              {adminError}
            </span>
          )}
        </div>
      </section>

      <section className="panel" aria-labelledby="account-h">
        <p className="caption">{partCaption("account")}</p>
        <h2 id="account-h">Vault account</h2>
        {!wallet.account ? (
          <div className="actions">
            <button type="button" className="btn" onClick={wallet.connect} disabled={wallet.busy} aria-describedby={describedBy(wallet.error && "create-wallet-error")}>
              Connect wallet
            </button>
            <WalletError id="create-wallet-error" />
          </div>
        ) : (
          <>
            <p className="small body">
              Network: NEAR {NETWORK}. Paid and created from <span className="mono">{wallet.account}</span>.
            </p>
            <div className="field-group">
              <label className="label" htmlFor="vault-name">
                Vault name
              </label>
              <input
                id="vault-name"
                className="field"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={locked}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={nameBad}
                aria-describedby={describedBy(vault?.ok && "vault-name-hint", nameBad && "vault-name-error")}
              />
              {vault?.ok && (
                <span id="vault-name-hint" className="hint">
                  The account will be {vault.id}
                </span>
              )}
              {nameBad && vault && !vault.ok && (
                <span id="vault-name-error" className="hint error">
                  {vault.error}
                </span>
              )}
            </div>
            <div className="field-group">
              <label className="label" htmlFor="funding">
                Funding (NEAR)
              </label>
              <input
                id="funding"
                className="field num"
                inputMode="decimal"
                value={funding}
                onChange={(e) => setFunding(e.target.value)}
                disabled={locked}
                aria-invalid={fundingBad}
                aria-describedby={describedBy("funding-hint", fundingBad && "funding-error")}
              />
              <span id="funding-hint" className="hint">
                At least 0.05. It pays for the account and for the next two transactions. Add more after the vault has its contract.
              </span>
              {fundingBad && (
                <span id="funding-error" className="hint error">
                  Enter a plain amount of at least 0.05.
                </span>
              )}
            </div>
          </>
        )}
      </section>

      <section className="panel" aria-labelledby="steps-h">
        <p className="caption">{partCaption("steps")}</p>
        <h2 id="steps-h">Steps</h2>
        <ol className="rows">
          {steps.map((s, i) => (
            <li key={s.id}>
              <span className="row-title">
                <span>
                  {i + 1}. {STEP_TEXT[s.id].title}
                </span>
                <span className="chip" data-tone={s.status === "done" ? "valid" : s.status === "failed" ? "invalid" : s.status === "running" ? "warning" : undefined}>
                  {STATUS_TEXT[s.status]}
                </span>
              </span>
              <span className="row-detail">{STEP_TEXT[s.id].detail}</span>
              {s.tx && (
                <span className="small">
                  <a className="link" href={txUrl(NETWORK, s.tx)} target="_blank" rel="noopener noreferrer">
                    Transaction {s.tx.slice(0, 8)}...
                  </a>
                </span>
              )}
              {s.error && <span className="hint error">{s.error}</span>}
            </li>
          ))}
        </ol>
        {tempPub && (
          <p className="small body">
            Temporary key: <span className="mono">{tempPub}</span>
          </p>
        )}
        <div className="actions">
          {next && vault?.ok && (
            <button type="button" className="btn" onClick={startNext} disabled={busy || !ready}>
              {busy ? "Working..." : steps[nextIndex]?.status === "failed" ? "Retry this step" : `Run ${stepCaption(next).toLowerCase()}`}
            </button>
          )}
          {failedCreate && (
            <button type="button" className="btn btn-secondary" onClick={reconcile} disabled={busy}>
              Check the chain and continue
            </button>
          )}
        </div>
        {tempLive && <p className="small body">Keep this tab open until step {TEMP_KEY_GONE_AT} is done. The temporary key exists only here.</p>}
      </section>

      {note && (
        <p role="alert" className="callout" data-tone="warning">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="callout" data-tone="invalid">
          {error}
        </p>
      )}
      {steps.every((s) => s.status === "done") && vault?.ok && (
        <p role="status" className="callout" data-tone="valid">
          <strong>Done.</strong>
          <span>{vault.id} now has only your admin key. Deploying the Mamori contract onto it is the next step and is not part of this page.</span>
        </p>
      )}

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Create and fund this vault?">
        <dl className="kv" style={{ gridTemplateColumns: "1fr" }}>
          <div>
            <dt>Vault account</dt>
            <dd className="mono">{vault?.ok ? vault.id : ""}</dd>
          </div>
          <div>
            <dt>Funded from your wallet</dt>
            <dd>{funding} NEAR on {NETWORK}</dd>
          </div>
          <div>
            <dt>Admin key fingerprint</dt>
            <dd className="mono">{admin?.handle}</dd>
          </div>
        </dl>
        <p className="small body">Your wallet will ask you to approve the transaction. Nothing is sent until you do.</p>
        <div className="actions">
          <button type="button" className="btn btn-secondary btn-compact" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-compact"
            onClick={() => {
              setConfirm(false);
              void run("create");
            }}
          >
            Create and fund
          </button>
        </div>
      </Modal>
    </div>
  );
}
