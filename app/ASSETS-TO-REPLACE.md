# Assets derived from Family (family.co), to replace before publishing

The landing page at `/` was built on the Family template look, using the files that were in `site/`. These are Family's assets or are derived from its template. They are here so the page works and looks right now; replace each one before the project is published. Nothing in this list is licensed to this project.

## Fonts

The template typefaces (Family, LFE Sans) are no longer used: the landing page uses Figtree from Google Fonts (`next/font`, self-hosted at build). `Inter-var-latin.woff2` is Inter.

## Images (`public/assets/`, `public/media/`)

| File | Where it is used |
|---|---|
| `public/assets/phone.png` | Template phone mock-up |
| `public/assets/home/emoji_1.png` to `emoji_10.png` | Template emoji artwork |
| `public/media/family_accounts.png` | Template section artwork |
| `public/media/why_family_accounts.png` | Template section artwork |

## Videos and posters (`public/videos/`)

All of these are Family's product videos and stills, used by the sections in `components/landing/sections/`:
`activity`, `dragdropdone`, `missioncontrol`, `nft`, `onboarding`, `receive`, `send`, `swap`, `watch` (each `.mp4` and `.png`), `promo-wallet.mp4` and `promo-wallet.jpg` (the "See how it works" modal), and `promo_activity.png`, `promo_collectibles.png`, `promo_watch.png`.

## Template code and styles

| File | Note |
|---|---|
| `app/(landing)/landing.css` | The Family template stylesheet (hashed class names such as `Topbar__Content-sc-gsec0x-0`). Changes made here: the Google-hosted Inter faces were removed in favour of the local file, and a focus ring, a caveat bar and a reduced-motion rule were added at the end. |
| `components/landing/Header.tsx`, `Footer.tsx`, `VideoModal.tsx`, `VideoSequence.tsx` | Markup and behaviour ported from the template |
| `components/landing/sections/*.tsx` | The template's sections with this project's words in them; the layout, class names and inline SVG artwork are the template's |

## Not Family's (keep)

- `public/media/kaigen-hero.mp4` and `kaigen-hero.png`, and `components/landing/HeroGraphic.tsx`: this project's own hero.
- `components/landing/ConnectButton.tsx`, `LandingProviders.tsx`: written for this project.
- `public/media/era-kanji.png`, `components/landing/EraKanji.tsx`: 改元 in pixel brush calligraphy under "One signed claim moves the era." Generated for this project from the Yu Gothic glyphs that ship with Windows (the pixel art is a derived image, not the font; check the font's licence terms before publishing). The generator is `D:\HACK-Projects\NEAR_Hack\scratch\pw\kanji.mjs`, not in the repo.
- `public/media/katana-ink.png`: the black-ink katana with crows beside "Explore KAIGEN". The drawing is supplied by the project owner (their file `30.png`); the PNG is that drawing with the white made transparent, resized to 640 px wide, and the ground at its lower left broken into specks. The footer's black (`#060609`) is the drawing's own ink colour. Provenance of the original drawing is not recorded here: confirm the right to publish it.
- The Family phone mock-ups, "See how it works" video links, wallet cards and the explore panels (dark card, Back Up Now, timeline, emoji avatars) were removed from the landing, along with the matching `public/videos/` and `public/assets/` files being unused now. They are still on disk and listed above; delete them when you are ready.
- `public/media/ink/*.png` (samurai, pagoda, torii, katana-field, bamboo, cherry, blade, dragon, lily, kabuto), `components/landing/InkArt.tsx`: ink drawings supplied by the project owner (from their Downloads folder), with the paper made transparent so they sit on the page background (white or cream removed; ink and red kept; cut edges of cropped drawings break into specks). Where each came from is not recorded here: confirm the right to publish every one. `cherry.png` is about 0.7 MB; shrink it before publishing.

## Known gap

`components/landing/sections/SectionDetails.tsx` refers to `/assets/home/benji.png`, `jacob.png` and `alex.png`. They were not in `site/public` either, so they return 404 today (small avatar images inside an SVG). Replace them or remove the references.

- `components/landing/CryptoIcons.tsx`: simplified NEAR, Bitcoin and Ethereum outlines used in the "Two curves" list, drawn for this project (line icons, not the brands' official logo files): swap in the official assets before publishing.
- `components/landing/EraPanels.tsx` and `public/media/katana-ink.png`: the explore steps (red kanji seals, text only) and the black-ink katana beside "Explore KAIGEN" (the owner's drawing, white made transparent).
- `public/media/ink/katana-field.png` (0.8 MB; shrink before publishing): the owner's katana-in-grass drawing, rebuilt so the grass spreads and thins into the page (clumps of the drawing's own grass copied out around the blade; the handle's cut top breaks into specks). The FAQ section uses `ink/lily.png` as its backdrop (CSS `.faq-backdrop`, 22% strength). The "Notes from the build" section and every link to it were removed.
- `components/RouteBackdrop.tsx`: puts one of the ink drawings above (samurai on /start, torii on /omens, kabuto on /vault, bamboo on /vault/create, dragon on /bounty) beside the header of each app page. The key page /migrate has none on purpose. Same provenance note as the drawings.
