// Encrypted backup of the ML-DSA-65 admin seed. The plan makes this mandatory before a vault is created:
// if the admin key is lost, funds are stuck after kaigen. Everything runs in the browser.

const ITERATIONS = 600_000;
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface BackupFile {
  v: 1;
  app: "kaigen";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  /** Public, so the backup can be matched to a vault without decrypting. */
  publicKey: string;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number, usage: KeyUsage[]) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

export async function encryptSeed(seed: Uint8Array, publicKey: string, passphrase: string): Promise<BackupFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, seed as BufferSource));
  return {
    v: 1,
    app: "kaigen",
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(ciphertext),
    publicKey,
  };
}

/** Throws if the passphrase is wrong or the file was altered (AES-GCM authenticates). */
/** A problem with the backup file or passphrase, with a message that is safe to show. */
export class BackupError extends Error {}

/** The iteration count comes from the file, so it is bounded: a crafted file must not freeze the tab. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;

const decode = (s: unknown): Uint8Array => {
  try {
    return unb64(String(s));
  } catch {
    throw new BackupError("This backup file is damaged.");
  }
};

export async function decryptSeed(file: BackupFile, passphrase: string): Promise<Uint8Array> {
  if (file.v !== 1 || file.app !== "kaigen") throw new BackupError("This is not a KAIGEN backup file.");
  if (!Number.isInteger(file.iterations) || file.iterations < MIN_ITERATIONS || file.iterations > MAX_ITERATIONS) {
    throw new BackupError("This backup file uses unsupported settings.");
  }
  const salt = decode(file.salt);
  const iv = decode(file.iv);
  const ciphertext = decode(file.ciphertext);
  const key = await deriveKey(passphrase, salt, file.iterations, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource));
  } catch {
    // AES-GCM authenticates: a wrong passphrase and an altered file both end here.
    throw new BackupError("Wrong passphrase, or the file was changed.");
  }
}

export function downloadBackup(file: BackupFile) {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kaigen-admin-key-${file.publicKey.slice(11, 19)}.json`;
  // Attached to the page, and the URL kept alive for a moment: some browsers cancel the download otherwise.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
