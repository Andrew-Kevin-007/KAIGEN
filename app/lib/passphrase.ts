// A sanity floor for the backup passphrase, not a guarantee: the backup file can be copied and attacked offline,
// so the passphrase is the only thing between a stolen file and the admin seed. The key derivation is slow
// (PBKDF2, 600k rounds) but a guessable phrase still falls. Length alone let "password1234" through.

export const MIN_PASSPHRASE = 12;
const MIN_BITS = 40;
/** A passphrase is "common" when known weak words make up this share of it. */
const COMMON_SHARE = 0.6;

const TOO_SHORT = `Use at least ${MIN_PASSPHRASE} characters.`;
const TOO_COMMON = "That passphrase is too common. Pick something only you would think of, such as four or five unrelated words.";
const TOO_SIMPLE = "That passphrase is a simple repeat or sequence. Mix in different words or characters.";
const TOO_FEW = "That passphrase does not use enough different characters. Try a longer phrase of unrelated words.";

// Short on purpose: the best-known weak passwords and phrases, plus this project's own names.
const COMMON = [
  ...["password", "passw0rd", "passphrase", "mypassword", "letmein", "welcome", "iloveyou", "iloveu", "administrator", "admin", "login", "changeme", "default", "secret"],
  ...["qwerty", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm", "abcdef", "abc123", "trustno1"],
  ...["123456", "1234567", "12345678", "123456789", "1234567890", "111111", "000000"],
  ...["princess", "sunshine", "football", "baseball", "basketball", "dragon", "monkey", "master", "shadow", "superman", "batman", "starwars", "whatever", "freedom"],
  ...["computer", "internet", "michael", "jennifer", "hunter", "ranger", "charlie", "hello", "lovely", "flower", "mustang", "soccer", "killer", "cookie", "summer", "winter"],
  ...["correcthorsebatterystaple", "bitcoin", "ethereum", "blockchain", "crypto", "wallet", "nearprotocol", "kaigen", "mamori", "kizashi"],
]
  .filter((w, i, all) => all.indexOf(w) === i)
  .sort((a, b) => b.length - a.length);

const LEET: Record<string, string> = { "@": "a", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", $: "s" };
const RUNS = ["abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm", "01234567890123456789"].flatMap((s) => [s, [...s].reverse().join("")]);

/** Share of `text` that known weak words account for. */
function commonShare(text: string): number {
  if (!text) return 0;
  let rest = text;
  for (const word of COMMON) rest = rest.split(word).join("");
  return (text.length - rest.length) / text.length;
}

function isCommon(p: string): boolean {
  const lower = p.toLowerCase();
  const plain = lower.replace(/[^a-z0-9]/g, "");
  const unleeted = [...lower].map((c) => LEET[c] ?? c).join("").replace(/[^a-z]/g, "");
  return commonShare(plain) >= COMMON_SHARE || commonShare(unleeted) >= COMMON_SHARE;
}

function isSimple(p: string): boolean {
  const lower = p.toLowerCase();
  // A short unit repeated ("abababababab", "kaigenkaigen"), allowing a few stray characters at the end.
  if (/^(.{1,6})\1+.{0,3}$/s.test(lower)) return true;
  const plain = lower.replace(/[^a-z0-9]/g, "");
  return plain.length >= 8 && RUNS.some((run) => run.includes(plain));
}

/** Rough bits of guessing work: each new character costs the size of the alphabet used, a repeat costs one bit. */
export function estimateBits(p: string): number {
  let pool = 0;
  if (/[a-z]/.test(p)) pool += 26;
  if (/[A-Z]/.test(p)) pool += 26;
  if (/\d/.test(p)) pool += 10;
  if (/[ -/:-@[-`{-~]/.test(p)) pool += 33;
  if (/[^\x00-\x7f]/.test(p)) pool += 100;
  if (pool === 0) return 0;
  const perNew = Math.log2(pool);
  const seen = new Set<string>();
  let bits = 0;
  for (const ch of p) {
    if (seen.has(ch)) bits += 1;
    else {
      seen.add(ch);
      bits += perNew;
    }
  }
  return bits;
}

export function checkPassphrase(p: string): { ok: boolean; message: string } {
  if (p.length < MIN_PASSPHRASE) return { ok: false, message: TOO_SHORT };
  if (isCommon(p)) return { ok: false, message: TOO_COMMON };
  if (isSimple(p)) return { ok: false, message: TOO_SIMPLE };
  if (estimateBits(p) < MIN_BITS) return { ok: false, message: TOO_FEW };
  return { ok: true, message: "" };
}
