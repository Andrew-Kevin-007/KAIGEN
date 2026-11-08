import "./site-footer.css";

/**
 * The one footer for the whole site: the homepage's (logo, three link columns, © 2026 under a hairline). It renders only
 * the <footer>; the landing page places it inside its closing "Explore KAIGEN" section and the app layout inside its
 * container. Links are absolute (/#...) so they work from any page.
 */
export function SiteFooter() {
  return (
    <footer className="sf">
      <a className="sf-logo" href="/" aria-label="KAIGEN, home">
        KAIGEN
      </a>
      <nav aria-label="Footer">
        <ul className="sf-cols">
          <li>
            <h5>Build</h5>
            <ul>
              <li>
                <a href="/#mechanism">Contracts</a>
              </li>
            </ul>
          </li>
          <li>
            <h5>Resources</h5>
            <ul>
              <li>
                <a href="/#features">Limits</a>
              </li>
              <li>
                <a href="/#transparency">Fire tests</a>
              </li>
              <li>
                <a href="/#faqs">FAQs</a>
              </li>
            </ul>
          </li>
          <li>
            <h5>Project</h5>
            <ul>
              <li>
                <a href="https://nearhackathon.com/" target="_blank" rel="noopener noreferrer">
                  NEAR HACKATHON
                </a>
              </li>
            </ul>
          </li>
        </ul>
      </nav>
      <p className="sf-legal">© 2026</p>
    </footer>
  );
}
