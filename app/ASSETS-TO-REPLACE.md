# Template-derived files in the landing page

The landing page at `/` started from the Family (family.co) template look. What remains of it in this repository is code and styles only. The template's fonts, videos, phone mock-ups and emoji artwork are not in the repository and are not referenced.

| File | Note |
|---|---|
| `app/(landing)/landing.css` | Template stylesheet (hashed class names such as `Topbar__Content-sc-gsec0x-0`). The typeface was replaced with Figtree from Google Fonts (`next/font`, served from our own host at build time). |
| `components/landing/Header.tsx`, `Footer.tsx`, `VideoModal.tsx`, `VideoSequence.tsx` | Markup and behaviour ported from the template |
| `components/landing/sections/*.tsx` | The template's section layout, class names and inline SVG artwork, with this project's words in them |

Everything else on the landing page and in the app is this project's own: the ink drawings in `public/media/ink/` and `public/media/katana-ink.png` (supplied by the project owner), `ConnectButton.tsx`, `LandingProviders.tsx`, `InkArt.tsx`, `EraPanels.tsx`, `CryptoIcons.tsx` and `RouteBackdrop.tsx`.

Known gap: `components/landing/sections/SectionDetails.tsx` refers to `/assets/home/benji.png`, `jacob.png` and `alex.png`, which are not in the repository (small avatar images inside an SVG). They return 404 today.
