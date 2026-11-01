const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "";

export function Footer() {
  return (
    <div className="container">
      <div className="footer-rule" />
      <footer className="site-footer">
        <div className="footer-left">
          <div className="wordmark" style={{ color: "var(--body)" }}>
            KAIGEN
          </div>
          <p className="footer-note">Unaudited. Mainnet at your own risk. Drill omens and drill vaults are always labelled drill; nothing here means a production omen has broken.</p>
          <p className="footer-legal">© 2026</p>
        </div>
        <nav aria-label="Footer">
          <div className="footer-cols">
            <div>
              <h3>Build</h3>
              <ul>
                <li>
                  <a href={`${SITE}/#mechanism`}>Contracts</a>
                </li>
              </ul>
            </div>
            <div>
              <h3>Resources</h3>
              <ul>
                <li>
                  <a href={`${SITE}/#features`}>Limits</a>
                </li>
                <li>
                  <a href={`${SITE}/#transparency`}>Fire tests</a>
                </li>
                <li>
                  <a href={`${SITE}/#notes`}>Build notes</a>
                </li>
                <li>
                  <a href={`${SITE}/#faqs`}>FAQs</a>
                </li>
              </ul>
            </div>
            <div>
              <h3>Project</h3>
              <ul>
                <li>
                  <a href="https://nearhackathon.com/" target="_blank" rel="noopener noreferrer">
                    NEAR HACKATHON
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </nav>
      </footer>
    </div>
  );
}
