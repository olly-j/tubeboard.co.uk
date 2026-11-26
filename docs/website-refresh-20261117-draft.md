# TB-150 website copy preparation, 17 November 2026

Relates to olly-j/My-Train-Times#618. Status: draft source, not public-ready.

This copy prepares the station → train destination → departure-time story for the owner-selected corrected release. It removes obsolete launch/coming-soon notices and describes station resume, the large widget’s two directions and station tap, the Lock Screen board and Follow stops in ordinary product language. Existing Premium access, all prices, links, source qualification and privacy rules are unchanged.

## Current release candidate

The home page hero shows Woodford’s predicted Central line departures on platforms 2 and 3. The PNG is the original iPhone simulator capture from the ordinary Release build 20261118110726, version 1.2.6, at source ed2e82e43f17d999941dc13eba679b5937e8b13e. The WebP copy has identical decoded RGB pixels.

The Follow section uses a controlled Woodford route on iPhone simulator from local build 20261121233653. The social card retains its separate capture provenance in build 20261118001152. The earlier Lock Screen asset is retained in source. The paired iPad and iPhone storefront images and seven en-GB metadata fields are in the private release evidence directory.

Add Station still uses build 20261117225101. Home shows saved Leyton and recent Brixton in a raw native iPhone 17 Pro Max simulator capture from 1.2.6 (20261121142731), using a controlled saved and recent station setup. Both new PNGs are original captures and the WebP versions preserve their pixels. By destination and Next departures retain earlier captures. See website-refresh-20261117-assets.json for provenance. Paid Follow was exercised using a local StoreKit test transaction. Sustained background delivery, StandBy geometry and a paired Watch still require physical verification.

This branch is a website source draft. Publication is a separate owner decision. Its service base includes code beyond the currently deployed production version. A website-only release must select the intended deployable revision and preserve production service configuration.

## 26 November website review

The homepage leads with station search and train countdowns and explains Scheduled times separately. Follow a Train describes supported route and stop information, with live progress and sharing qualified by the train evidence. The Lock Screen Live Activity has three free sessions. The separate Home Screen and Lock Screen widgets require Premium. The support page gives the matching setup, recovery and refresh instructions.

The website branch incorporates service main at `ffe5c1fe5594a2270cfe129cf0952e78adbf0c40`. Hosted Service Quality exposed two earlier timing-dependent fixtures after the old draft fixes were dropped from the merge. The HTTP endpoint test now controls its test clock at a minute boundary, and the timer test waits for persistence or transport progress without advancing the virtual clock. Both retain their service assertions. Runtime and configuration match service main. The release candidate reviewed for claims is iOS 1.2.6 build 20261122004457 from app PR 916. Asset provenance remains per image.
