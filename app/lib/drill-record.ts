// A recorded fire drill, replayed on the Era page. Every value is a public testnet identifier copied from
// .kaigen-testnet/fire-tests/0004.json (no keys, no seeds). It is a drill: nothing here means a production omen broke.
export const DRILL_RECORD = {
  seq: 4,
  network: "testnet",
  kizashi: "kizashi.kaigen-g1-0170217f.testnet",
  omenId: "drill-secp256k1-omen",
  vault: "vault.kaigen-g1-0170217f.testnet",
  claimTx: "Gk7AjWyUtR5RiVnYPE8sdk2a5ASuifBcaKkuDj5QKQiD",
  claimBlock: 275282931,
  tripTx: "DUxdethJcQNFnP7pYyJRdP21B6zedXy7aPx2YcAoT1ri",
  verifiedBlock: 275282943,
  pqSendTx: "8JtBRR2aDJNriUb7AKd1LqRfQm2S3gJrTKQu86XUNBiB",
  resetTx: "5er2JsuGN8cJatBaULg8z5y4qn1jBzBuw927wNQWhd5o",
  rearmTx: "5mZNFJGtWRLTC75RVW9eC7r8RPsGtt7L6ujcZEB74VgJ",
} as const;
