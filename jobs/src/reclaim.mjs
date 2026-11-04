// Gives back the NEAR held by the sub-accounts a testnet rehearsal created, so a failed run does not burn the
// faucet's one request per IP per 12 hours. Each sub-account (<role>.<funder>.testnet) deletes itself and pays
// its balance to its funder; then a funder file for `KAIGEN_FUNDER_FILE` is written for the chosen funder.
//
//   node jobs/src/reclaim.mjs <testnet dir> <funder account id>
//
// Testnet only, and only accounts whose keys are in <dir>/accounts.json (made by the rehearsal, holding no value).
import fs from "node:fs";
import path from "node:path";
import { actions, sendTx } from "@fastnear/api";
import { signerFromPrivateKey } from "@fastnear/utils";
import { signerFromSeed } from "@fastnear/ml-dsa-65";

const [dir, chosenFunder] = process.argv.slice(2);
if (!dir || !chosenFunder) {
  console.error("usage: node jobs/src/reclaim.mjs <testnet dir> <funder account id>");
  process.exit(2);
}
const accounts = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
if (!accounts[chosenFunder]) {
  console.error(`${chosenFunder} is not in ${path.join(dir, "accounts.json")}`);
  process.exit(2);
}

// A rehearsal vault's only full-access key is its ML-DSA-65 admin key (the classical key is deleted), whose seed
// the rehearsal wrote to admin-seeds.json beside accounts.json. Use it for those accounts.
const seedsFile = path.join(dir, "admin-seeds.json");
const seeds = fs.existsSync(seedsFile) ? JSON.parse(fs.readFileSync(seedsFile, "utf8")) : {};

for (const [id, key] of Object.entries(accounts)) {
  const dot = id.indexOf(".");
  const parent = dot === -1 ? null : id.slice(dot + 1);
  if (!parent || !accounts[parent] || !id.endsWith(".testnet")) continue; // only sub-accounts of a funder we hold
  const del = [actions.deleteAccount({ beneficiaryId: parent })];
  const send = (signer) => sendTx({ signerId: id, signer, receiverId: id, actions: del, waitUntil: "FINAL", network: "testnet" });
  try {
    try {
      await send(signerFromPrivateKey(key.privateKey));
    } catch (e) {
      if (!seeds[id] || !/does not exist/.test(String(e.message ?? e))) throw e;
      await send(signerFromSeed(Uint8Array.from(Buffer.from(seeds[id], "hex"))));
    }
    console.log(JSON.stringify({ step: "reclaimed", account: id, to: parent }));
  } catch (e) {
    console.log(JSON.stringify({ step: "skipped", account: id, why: String(e.message ?? e).slice(0, 160) }));
  }
}

const funderFile = path.join(dir, "funder.json");
fs.writeFileSync(funderFile, JSON.stringify({ account_id: chosenFunder, private_key: accounts[chosenFunder].privateKey }, null, 2));
console.log(JSON.stringify({ step: "funder file written", file: funderFile, funder: chosenFunder }));
