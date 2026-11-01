"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { BackupError, decryptSeed, downloadBackup, encryptSeed, type BackupFile } from "@/lib/backup";
import { MIN_PASSPHRASE, checkPassphrase } from "@/lib/passphrase";
import { VAULT_CREATE_ENABLED } from "@/lib/vault-create";

type Step = 0 | 1 | 2 | 3;
const STEPS = ["Key", "Backup", "Verify", "Vault"];

const wipe = (secret: { current: Uint8Array | null }) => {
  secret.current?.fill(0);
  secret.current = null;
};

export function MigrateClient() {
  const [step, setStep] = useState<Step>(0);
  const [publicKey, setPublicKey] = useState("");
  const [fullKey, setFullKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [saved, setSaved] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState("");
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [why, setWhy] = useState(false);
  const seed = useRef<Uint8Array | null>(null);
  const backup = useRef<BackupFile | null>(null);

  // Secret material does not outlive the page.
  useEffect(() => () => wipe(seed), []);

  // Moving to a new step removes the button that had focus, so send focus to the new step's heading.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    document.querySelector<HTMLElement>("[data-step-heading]")?.focus();
  }, [step]);

  const fail = (e: unknown) => setError(e instanceof BackupError || e instanceof Error ? e.message : String(e));
  const go = (next: Step) => {
    setError("");
    // The seed exists only while the backup step is on screen, and the passphrase only until the backup is saved.
    // Later steps work from the encrypted file, so they need neither.
    if (next !== 1) wipe(seed);
    if (next >= 2) {
      setPassphrase("");
      setAgain("");
    }
    setStep(next);
  };

  function startOver() {
    backup.current = null;
    setPublicKey("");
    setFullKey("");
    setSaved(false);
    setRestoreFile(null);
    setRestorePass("");
    setRestored(false);
    go(0);
  }

  async function generate() {
    setBusy(true);
    setError("");
    try {
      // Loaded on demand: the post-quantum library is large and only this page needs it.
      const { generateSigner } = await import("@fastnear/ml-dsa-65");
      const signer = generateSigner();
      try {
        seed.current = signer.exportSeed();
        setPublicKey(signer.publicKeyHandle);
      } finally {
        signer.destroy();
      }
      go(1);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function saveBackup() {
    if (!seed.current) return;
    setBusy(true);
    setError("");
    try {
      if (!globalThis.crypto?.subtle) throw new Error("Encryption needs a secure page (https or localhost).");
      const { signerFromSeed } = await import("@fastnear/ml-dsa-65");
      const s = signerFromSeed(seed.current);
      try {
        const file = await encryptSeed(seed.current, s.publicKey, passphrase);
        backup.current = file;
        setFullKey(file.publicKey);
        downloadBackup(file);
        setSaved(true);
      } finally {
        s.destroy();
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // The restore the person would do after losing everything: the file and the passphrase typed from memory. The
  // passphrase from the backup step is already gone, so this cannot pass on a value the page kept for it.
  async function testRestore() {
    if (!restoreFile || !backup.current) return;
    setBusy(true);
    setError("");
    setRestored(false);
    let recovered: Uint8Array | null = null;
    try {
      let parsed: BackupFile;
      try {
        parsed = JSON.parse(await restoreFile.text()) as BackupFile;
      } catch {
        throw new BackupError("That file is not a KAIGEN backup.");
      }
      if (parsed.publicKey !== backup.current.publicKey) throw new BackupError("This backup belongs to a different key.");
      recovered = await decryptSeed(parsed, restorePass);
      const { signerFromSeed } = await import("@fastnear/ml-dsa-65");
      const s = signerFromSeed(recovered);
      try {
        if (s.publicKey !== parsed.publicKey) throw new BackupError("The backup decrypts, but to a different key.");
      } finally {
        s.destroy();
      }
      setRestorePass("");
      setRestored(true);
    } catch (e) {
      fail(e);
    } finally {
      wipe({ current: recovered });
      setBusy(false);
    }
  }

  const strength = checkPassphrase(passphrase);
  const passphraseOk = strength.ok && passphrase === again;
  const weak = passphrase.length >= MIN_PASSPHRASE && !strength.ok;

  return (
    <div className="container page">
      <div className="reading">
        <header className="page-head">
          <h1>Protect an account</h1>
          <p className="lead">
            Move into a vault with a post-quantum admin key. The admin key is the only key that can do everything. You keep limited classical keys for daily use, and those are the
            ones KAIGEN deletes when an omen breaks.
          </p>
        </header>

        <div className="panel">
          <p className="caption" role="status">
            {step + 1} of {STEPS.length}: {STEPS[step]}
          </p>

          {step === 0 && (
            <>
              <h2 data-step-heading tabIndex={-1}>
                Create the admin key
              </h2>
              <p className="body">It is made in this browser. It never leaves your device unencrypted, and KAIGEN never sees it.</p>
              <div className="actions">
                <button type="button" className="btn" onClick={generate} disabled={busy}>
                  {busy ? "Creating..." : "Create admin key"}
                </button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h2 data-step-heading tabIndex={-1}>
                Save an encrypted backup
              </h2>
              <div className="field-group">
                <span className="label">Public key</span>
                <p className="mono">{publicKey}</p>
              </div>
              <div className="field-group">
                <label className="label" htmlFor="pass">
                  Passphrase
                </label>
                <input id="pass" className="field" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} aria-describedby="pass-hint" aria-invalid={weak} />
                <span id="pass-hint" className="hint">
                  At least {MIN_PASSPHRASE} characters, and not a common one. Four or five unrelated words work well. There is no recovery if you forget it.
                </span>
                {weak && <span className="hint error">{strength.message}</span>}
              </div>
              <div className="field-group">
                <label className="label" htmlFor="again">
                  Repeat passphrase
                </label>
                <input id="again" className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={Boolean(again) && passphrase !== again} />
                {again && passphrase !== again && <span className="hint error">Does not match.</span>}
              </div>
              <div className="callout" data-tone="warning">
                <strong>A backup is required.</strong>
                <span>
                  If this key is lost, funds in the vault cannot be moved after kaigen.{" "}
                  <button type="button" className="link" onClick={() => setWhy(true)}>
                    Why this matters
                  </button>
                </span>
              </div>
              <div className="actions">
                <button type="button" className="btn" onClick={saveBackup} disabled={!passphraseOk || busy}>
                  {busy ? "Encrypting..." : saved ? "Download again" : "Download backup"}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => go(2)} disabled={!saved}>
                  I saved it
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2 data-step-heading tabIndex={-1}>
                Test a restore
              </h2>
              <p className="body">
                Do what you would do after losing everything: open the backup file and type the passphrase from memory. It is decrypted here to check it recovers the same key, and
                nothing leaves this page. The key itself has already been cleared from this page, so this file is now the only copy.
              </p>
              <div className="field-group">
                <label className="label" htmlFor="file">
                  Backup file
                </label>
                <input
                  id="file"
                  className="field"
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => {
                    setRestoreFile(e.target.files?.[0] ?? null);
                    setRestored(false);
                  }}
                  disabled={busy}
                />
              </div>
              <div className="field-group">
                <label className="label" htmlFor="restore-pass">
                  Passphrase
                </label>
                <input id="restore-pass" className="field" type="password" autoComplete="current-password" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} disabled={busy} />
              </div>
              <div className="actions">
                <button type="button" className="btn" onClick={testRestore} disabled={busy || !restoreFile || !restorePass}>
                  {busy ? "Restoring..." : "Test restore"}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => go(3)} disabled={!restored || busy}>
                  Continue
                </button>
                <button type="button" className="btn-text" onClick={startOver} disabled={busy}>
                  Start over with a new key
                </button>
              </div>
              {restored && (
                <div role="status" className="callout" data-tone="valid">
                  <strong>Restored.</strong>
                  <span>The backup opened with that passphrase and gave back the same key.</span>
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <h2 data-step-heading tabIndex={-1}>
                Create the vault
              </h2>
              <p className="body">Your backup is verified.</p>
              {VAULT_CREATE_ENABLED ? (
                <>
                  <p className="body">
                    The vault is created from your wallet on its own page, so the wallet never runs next to your key. Only the public key goes in the link; the secret is not in it.
                  </p>
                  {/* A plain anchor: this page and the next must not share a document. */}
                  <div className="actions">
                    <a className="btn" href={`/vault/create#key=${encodeURIComponent(fullKey)}`}>
                      Create the vault
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <div className="callout" data-tone="warning">
                    <strong>Not wired up yet.</strong>
                    <span>Creating the vault needs the on-chain checks for post-quantum keys (gates G1 and G3) to pass on mainnet first, so this step is switched off instead of pretending.</span>
                  </div>
                  <div className="actions">
                    <button type="button" className="btn" disabled>
                      Create vault
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {error && (
            <p role="alert" className="callout" data-tone="invalid">
              {error}
            </p>
          )}
        </div>
      </div>

      <Modal open={why} onClose={() => setWhy(false)} title="Why a backup is required">
        <p className="body">After kaigen, the classical keys are gone and the admin key is the only way to move your funds. If it is lost, nothing can recover it: not KAIGEN, not NEAR.</p>
        <p className="body">The backup file is encrypted with your passphrase. Keep the file and the passphrase in different places.</p>
        <div className="actions">
          <button type="button" className="btn btn-compact" onClick={() => setWhy(false)}>
            Got it
          </button>
        </div>
      </Modal>
    </div>
  );
}
