import { DEPLOYMENTS } from "@/lib/config";

/** Says so, on every route, when the deployment settings are wrong, so a mistyped setting does not read as "not deployed yet". */
export function ConfigNotice() {
  if (DEPLOYMENTS.problems.length === 0) return null;
  return (
    <div className="container" style={{ paddingTop: "1.25rem", width: "100%" }}>
      <div className="callout reading" data-tone="invalid" role="alert">
        <strong>The deployment settings are wrong.</strong>
        <ul>
          {DEPLOYMENTS.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <span>Fix NEXT_PUBLIC_DEPLOYMENTS (or the file KAIGEN_DEPLOYMENTS names) and build again.</span>
      </div>
    </div>
  );
}
