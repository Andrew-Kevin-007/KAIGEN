// Builds jobs/test/fixtures/trivial.wasm: the smallest sensible module for the publish-only MEASUREMENT run of
// `kaigen-jobs globalcontract publish` (docs/v3/GLOBAL-CONTRACT.md). It is hand-assembled from the wasm binary format, with
// no toolchain and no dependency, so anyone can rebuild it byte for byte:
//
//   node jobs/test/fixtures/make-trivial-wasm.mjs        (writes trivial.wasm and trivial.wasm.sha256 next to this file)
//
// The module: no imports, no memory, no floats; ONE exported function `ping` with the NEAR method signature () -> (); its body is
// `nop` repeated until the file is exactly 1,024 bytes, so the global-contract storage burn it causes is a round figure
// (1,024 bytes x 0.0001 NEAR = 0.1024 NEAR at the estimated rate) that is large enough to measure and small enough to
// spend. The runtime's contract preparation accepts a module with no memory import (near-vm-runner 0.38.0, prepare.rs:
// `(module)` prepares Ok). Whether DeployGlobalContract prepares the code at all is not known; the first real run shows it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** LEB128 of an unsigned integer. */
const leb = (n) => {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
};
const section = (id, body) => [id, ...leb(body.length), ...body];

export const TRIVIAL_WASM_BYTES = 1024;
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]; // "\0asm", version 1

/** The module with `nops` nops in `ping`'s body. */
const withNops = (nops) => {
  const type = section(1, [1, 0x60, 0, 0]); // one function type: () -> ()
  const func = section(3, [1, 0]); // one function, of type 0
  const exports = section(7, [1, 4, ...Buffer.from("ping"), 0x00, 0]); // export "ping" = function 0
  const body = [0, ...new Array(nops).fill(0x01), 0x0b]; // no local declarations, nop x nops, end
  const code = section(10, [1, ...leb(body.length), ...body]);
  return Buffer.from([...HEADER, ...type, ...func, ...exports, ...code]);
};

/** The fixture: `size` bytes exactly (default 1,024). Deterministic: the same bytes every time. */
export function buildTrivialWasm(size = TRIVIAL_WASM_BYTES) {
  for (let nops = 0; nops <= size; nops++) {
    const wasm = withNops(nops);
    if (wasm.length === size) return wasm;
    if (wasm.length > size) break;
  }
  throw new Error(`no trivial module is exactly ${size} bytes`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const wasm = buildTrivialWasm();
  const hex = createHash("sha256").update(wasm).digest("hex");
  fs.writeFileSync(path.join(dir, "trivial.wasm"), wasm);
  fs.writeFileSync(path.join(dir, "trivial.wasm.sha256"), `${hex}  trivial.wasm\n`);
  console.log(`trivial.wasm ${wasm.length} bytes, sha256 ${hex}`);
}
