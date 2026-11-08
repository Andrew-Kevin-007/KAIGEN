import { CAVEATS, WALKTHROUGH } from "@/lib/onboarding-content";

/** Short, read-only guidance. All text lives in lib/onboarding-content.ts, each step with the repository file it is read from. */
export function Walkthrough({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="section" aria-labelledby="walkthrough-h" id="walkthrough">
      <div className="stack-sm reading">
        <H id="walkthrough-h">How to read your vault</H>
        <p className="body">Six short notes, read only. Each one names the document in this repository it comes from.</p>
      </div>
      <p className="callout reading" data-tone="warning" role="note">
        <strong>{CAVEATS[0]}</strong>
        <span>{CAVEATS.slice(1).join(" ")}</span>
      </p>
      <ol className="rows reading">
        {WALKTHROUGH.map((step, i) => (
          <li key={step.id} id={`walkthrough-${step.id}`}>
            <span className="caption">
              Note {i + 1} of {WALKTHROUGH.length}
            </span>
            <span className="row-title">
              <span>{step.title}</span>
            </span>
            {step.paragraphs.map((p) => (
              <span key={p} className="row-detail">
                {p}
              </span>
            ))}
            {step.commands && (
              <span className="stack-sm" style={{ marginTop: 4 }}>
                {step.commands.map((c) => (
                  <code key={c} className="mono" style={{ background: "var(--gray-light)", borderRadius: 8, padding: "8px 12px", display: "block" }}>
                    {c}
                  </code>
                ))}
              </span>
            )}
            <span className="caption">Source: {step.source}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
