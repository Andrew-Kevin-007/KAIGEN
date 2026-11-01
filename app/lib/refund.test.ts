import test from "node:test";
import assert from "node:assert/strict";
import { refundAddressError } from "./refund.ts";

const VALID: Record<string, string[]> = {
  near: ["alice.near", "a1b2.sub.near", "a".repeat(64), "0x52908400098527886E0F7030069857D2E4169EE7"],
  eth: ["0x52908400098527886E0F7030069857D2E4169EE7"],
  base: ["0x52908400098527886E0F7030069857D2E4169EE7"],
  arb: ["0x52908400098527886E0F7030069857D2E4169EE7"],
  bsc: ["0x52908400098527886E0F7030069857D2E4169EE7"],
  pol: ["0x52908400098527886E0F7030069857D2E4169EE7"],
  btc: ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"],
  ltc: ["LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz", "ltc1qg82u8my2yq8u6n3tlkh0sge5usa3l0kts6u7j2"],
  doge: ["DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L"],
  zec: ["t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs"],
  sol: ["DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK"],
  ton: ["EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N", `0:${"ab".repeat(32)}`],
  xrp: ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"],
  tron: ["TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"],
  sui: [`0x${"ab".repeat(32)}`],
  aptos: ["0x1", `0x${"ab".repeat(32)}`],
  stellar: ["GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"],
  cardano: [`addr1${"q".repeat(58)}`],
  starknet: [`0x${"0".repeat(63)}1`],
  aleo: [`aleo1${"q".repeat(58)}`],
  // A chain this list does not know yet gets only the generic check, so a valid address is never refused.
  somenewchain: ["anything-123.valid"],
};

test("APP-6: valid addresses are accepted on every listed chain, with outer whitespace ignored", () => {
  for (const [chain, addrs] of Object.entries(VALID)) {
    for (const a of addrs) {
      assert.equal(refundAddressError(chain, a), null, `${chain}: ${a}`);
      assert.equal(refundAddressError(chain, `  ${a}\n`), null, `${chain}: padded ${a}`);
    }
  }
});

test("APP-6: empty and obviously malformed addresses are refused", () => {
  for (const chain of ["near", "eth", "btc", "sol", "somenewchain"]) {
    assert.match(refundAddressError(chain, "")!, /Enter the address/);
    assert.match(refundAddressError(chain, "   ")!, /Enter the address/);
    assert.ok(refundAddressError(chain, "has a space"), `${chain}: inner space`);
    assert.ok(refundAddressError(chain, "javascript:alert(1)"), `${chain}: script`);
    assert.ok(refundAddressError(chain, "x".repeat(300)), `${chain}: too long`);
  }
  assert.ok(refundAddressError("eth", "0x123"));
  assert.ok(refundAddressError("eth", "52908400098527886E0F7030069857D2E4169EE7"), "no 0x");
  assert.ok(refundAddressError("eth", "alice.near"), "a NEAR name is not an Ethereum address");
  assert.ok(refundAddressError("near", "Alice.near"), "uppercase");
  assert.ok(refundAddressError("near", "alice..near"));
  assert.ok(refundAddressError("near", "-alice.near"));
  assert.ok(refundAddressError("btc", "bc1"));
  assert.ok(refundAddressError("btc", "0x52908400098527886E0F7030069857D2E4169EE7"));
  assert.ok(refundAddressError("sol", "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"), "base58 excludes 0, O, I, l");
  assert.ok(refundAddressError("sol", "short"));
});

test("the message names the chain", () => {
  assert.match(refundAddressError("eth", "0x123")!, /eth/);
});
