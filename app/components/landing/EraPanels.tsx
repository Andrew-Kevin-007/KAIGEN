import "./samurai.css";

// The explanation under "One signed claim moves the era.", in the pixel style. The words are the section's own.
const STEPS = [
  { kanji: "兆", title: "Omens", text: "Omens are public keys that nobody holds." },
  { kanji: "証", title: "Prove", text: "Anyone can prove one broke with a signature." },
  { kanji: "破", title: "Trip", text: "Vaults delete classical keys when the era changes." },
  { kanji: "守", title: "Admin", text: "A post-quantum admin key stays in control.", chip: "Backup required" },
] as const;

const CARDS = [
  { title: "Automatic", text: "No oracle, no admin and nobody online. The contracts trust only signatures." },
  { title: "Bounded", text: "A broken classical key can only spend its daily limit." },
  { title: "Daily", text: "Hinomi publishes the exposure. Every day." },
  { title: "Open", text: "Anyone can run a keeper, rebuild the index or trip a vault." },
  { title: "Verifiable", text: "Check the claims yourself. One command, against mainnet." },
] as const;

export default function EraPanels() {
  return (
    <div className="era-panels">
      <ol className="era-steps">
        {STEPS.map((s) => (
          <li key={s.title} className="era-step">
            <span className="era-seal" aria-hidden="true">
              {s.kanji}
            </span>
            <div>
              <h5 className="era-step__title">
                {s.title}
                {"chip" in s && <span className="era-chip">{s.chip}</span>}
              </h5>
              <p className="era-step__text">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <ul className="era-cards">
        {CARDS.map((c) => (
          <li key={c.title} className="era-card">
            <h5 className="era-card__title">{c.title}</h5>
            <p className="era-card__text">{c.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
