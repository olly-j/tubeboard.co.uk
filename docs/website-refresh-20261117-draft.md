# TB-150 website copy preparation, 17 November 2026

Relates to olly-j/My-Train-Times#618. Status: draft source, not public-ready.

This copy prepares the station → train destination → departure-time story for the owner-selected corrected release. It removes obsolete launch/coming-soon notices and describes station resume, the large widget’s two directions and station tap, the Lock Screen board and Follow stops in ordinary product language. Existing Premium access, all prices, links, source qualification and privacy rules are unchanged.

## Current release candidate

The home page hero shows Woodford’s predicted Central line departures on platforms 2 and 3. The PNG is the original iPhone simulator capture from the ordinary Release build 20261118110726, version 1.2.6, at source ed2e82e43f17d999941dc13eba679b5937e8b13e. The WebP copy has identical decoded RGB pixels.

The existing Follow route, Lock Screen Live Activity and social card retain their independent capture provenance in build 20261118001152. The paired iPad and iPhone storefront images and seven en-GB metadata fields are in the private release evidence directory.

Add Station still uses build 20261117225101. The separate By destination, Next departures, Duo and disruption-widget images retain their earlier versions. See website-refresh-20261117-assets.json for provenance. Paid Follow was exercised using a local StoreKit test transaction. Sustained background delivery, StandBy geometry and a paired Watch still require physical verification.

This branch is a website source draft. Publication is a separate owner decision. Its service base includes code beyond the currently deployed production version. A website-only release must select the intended deployable revision and preserve production service configuration.

## 26 November website review

The homepage leads with station search and train countdowns and explains Scheduled times separately. Follow a Train describes supported route and stop information, with live progress and sharing qualified by the train evidence. The Lock Screen Live Activity has three free sessions. The separate Home Screen and Lock Screen widgets require Premium. The support page gives the matching setup, recovery and refresh instructions.

The website branch incorporates service main at `cf694ba1a8371b9aaf1839a83b1563afcf5c59d5`. The website PR no longer changes service tests, runtime or configuration. The previous draft test changes remain in branch history. The release candidate reviewed for claims is iOS 1.2.6 build 20261122004457 from app PR 916. Asset provenance remains per image.
