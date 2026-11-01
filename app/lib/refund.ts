// A refund goes to this address if a swap cannot finish, so a typo can lose a deposit. The patterns are
// conservative: they exist to stop empty and obviously malformed input, and are written wide enough that a valid
// address is never refused. A chain not listed here gets only the generic check.

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const BECH32 = "[ac-hj-np-z02-9]";
const re = (body: string, flags = "") => new RegExp(`^(?:${body})$`, flags);

const EVM = re("0x[0-9a-fA-F]{40}");
const HEX_ADDRESS = re("0x[0-9a-fA-F]{1,64}");
const BASE58_SVM = re(`${B58}{32,44}`);

const PATTERNS: Record<string, RegExp[]> = {
  near: [re("(?=.{2,64}$)(([a-z\\d]+[-_])*[a-z\\d]+\\.)*([a-z\\d]+[-_])*[a-z\\d]+"), re("[0-9a-f]{64}"), EVM],
  btc: [re(`bc1${BECH32}{6,87}`, "i"), re(`[13]${B58}{25,34}`)],
  ltc: [re(`ltc1${BECH32}{6,87}`, "i"), re(`[LM3]${B58}{25,34}`)],
  doge: [re(`[DA9]${B58}{25,34}`)],
  dash: [re(`[X7]${B58}{25,34}`)],
  bch: [re(`(bitcoincash:)?[qp][a-z0-9]{41}`, "i"), re(`[13]${B58}{25,34}`)],
  zec: [re(`t[13]${B58}{33}`), re("zs1[a-z0-9]{50,100}"), re("u1[a-z0-9]{50,400}")],
  sol: [BASE58_SVM],
  ton: [re("-?\\d+:[0-9a-fA-F]{64}"), re("[A-Za-z0-9_+/-]{48}")],
  xrp: [re(`r${B58}{24,34}`), re(`X${B58}{46}`)],
  tron: [re(`T${B58}{33}`)],
  sui: [HEX_ADDRESS],
  aptos: [HEX_ADDRESS],
  movement: [HEX_ADDRESS],
  starknet: [HEX_ADDRESS],
  stellar: [re("G[A-Z2-7]{55}"), re("M[A-Z2-7]{68}")],
  cardano: [re("addr1[a-z0-9]{50,120}"), re(`(Ae2|DdzFF)${B58}{50,110}`)],
  aleo: [re("aleo1[a-z0-9]{58}")],
};
for (const chain of ["eth", "base", "arb", "bsc", "pol", "gnosis", "bera", "op", "avax", "xlayer", "monad", "scroll"]) PATTERNS[chain] = [EVM];

const MAX_LENGTH = 200;
// What any address on any chain is made of. Rejects whitespace, quotes, brackets and the like.
const GENERIC = re("[A-Za-z0-9:_.+/=-]{3,200}");

/** Null when the address is acceptable for that chain, otherwise a message to show. `blockchain` is the 1Click chain name. */
export function refundAddressError(blockchain: string, address: string): string | null {
  const a = address.trim();
  if (!a) return "Enter the address a refund should go to.";
  const bad = `That does not look like a valid ${blockchain} address.`;
  if (a.length > MAX_LENGTH || !GENERIC.test(a)) return bad;
  const rules = PATTERNS[blockchain.toLowerCase()];
  if (!rules) return null;
  return rules.some((r) => r.test(a)) ? null : bad;
}
