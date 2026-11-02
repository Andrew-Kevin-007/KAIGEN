// Build-time half of the deployment settings (next.config.ts only; it uses the file system, so no page imports it).
// It turns the operator's deployments.json plus the published fire-test records into the one JSON string the app
// reads as NEXT_PUBLIC_DEPLOYMENTS. Only the public fields are copied: the file's other settings (init-file paths,
// the keeper's vault list, secondary RPC hosts) are tooling's business and stay out of the browser bundle.
import fs from "node:fs";
import path from "node:path";
import { parseDeployments, parseDrillRecord } from "./deployments.ts";

export interface LoadResult {
  /** What to hand the app as NEXT_PUBLIC_DEPLOYMENTS, or undefined when nothing is configured. */
  text: string | undefined;
  /** Where it came from, for the build log. */
  source: string;
  /** Sentences describing a setting that is wrong; the production build refuses to go on with any. */
  problems: string[];
}

const PUBLIC_FIELDS = ["network", "rpc", "kizashi", "mamoriReference", "mamoriCodeHash"] as const;

function readJson(file: string): { value?: unknown; problem?: string } {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) as unknown };
  } catch (e) {
    return { problem: `${file} could not be read as JSON (${(e as Error).message}).` };
  }
}

/** The newest fire-test record that is a usable drill record: the highest-numbered file that parses. */
export function latestFireTest(dir: string): { record: unknown; file: string } | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return null;
  }
  names.sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
  for (const n of names) {
    const file = path.join(dir, n);
    const { value } = readJson(file);
    if (value !== undefined && "record" in parseDrillRecord(value)) return { record: value, file };
  }
  return null;
}

/**
 * Order of precedence: NEXT_PUBLIC_DEPLOYMENTS set directly (it wins, and is passed through untouched apart from a
 * drill record filled in when it has none), then the file named by KAIGEN_DEPLOYMENTS, then ../deployments.json next
 * to this app when that exists. A file that is named but missing is a problem, not a silent fall-back.
 */
export function loadDeployments(env: Record<string, string | undefined> = process.env, appDir: string = process.cwd()): LoadResult {
  const problems: string[] = [];
  let doc: Record<string, unknown> | null = null;
  let source = "not configured: every page says Kizashi is not deployed yet";
  let baseDir = path.resolve(appDir, "..");

  const direct = env.NEXT_PUBLIC_DEPLOYMENTS;
  if (direct && direct.trim() !== "") {
    const parsed = parseDeployments(direct);
    problems.push(...parsed.problems);
    try {
      doc = JSON.parse(direct) as Record<string, unknown>;
    } catch {
      doc = null;
    }
    source = "NEXT_PUBLIC_DEPLOYMENTS";
  } else {
    const named = env.KAIGEN_DEPLOYMENTS?.trim();
    const file = named ? path.resolve(appDir, named) : path.resolve(appDir, "..", "deployments.json");
    if (named || fs.existsSync(file)) {
      if (!fs.existsSync(file)) {
        problems.push(`KAIGEN_DEPLOYMENTS points at ${file}, which does not exist.`);
      } else {
        const r = readJson(file);
        if (r.problem) problems.push(r.problem);
        else if (r.value !== null && typeof r.value === "object" && !Array.isArray(r.value)) {
          const src = r.value as Record<string, unknown>;
          doc = {};
          for (const k of PUBLIC_FIELDS) if (src[k] !== undefined) doc[k] = src[k];
          const drill = src.drill;
          if (drill !== null && typeof drill === "object" && !Array.isArray(drill) && (drill as Record<string, unknown>).kizashi !== undefined) {
            doc.drill = { kizashi: (drill as Record<string, unknown>).kizashi };
          }
          source = file;
          baseDir = path.dirname(file);
        } else problems.push(`${file} must hold a JSON object.`);
      }
    }
  }

  // The drill record is the latest published fire test unless the settings carry one.
  const firetests = env.KAIGEN_FIRE_TESTS?.trim() ? path.resolve(appDir, env.KAIGEN_FIRE_TESTS.trim()) : path.join(baseDir, "fire-tests");
  if (!doc || doc.drillRecord === undefined) {
    const found = latestFireTest(firetests);
    if (found) {
      doc = { ...(doc ?? {}), drillRecord: found.record };
      if (source.startsWith("not configured")) source = `only the recorded drill in ${found.file}`;
    }
  }

  if (!doc) return { text: undefined, source, problems };
  const text = JSON.stringify(doc);
  // What the app will make of it, so a build never ships a configuration the app would reject.
  for (const p of parseDeployments(text).problems) if (!problems.includes(p)) problems.push(p);
  return { text, source, problems };
}
