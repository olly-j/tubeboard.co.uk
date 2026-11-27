# TB-150 website copy preparation, 17 November 2026

Relates to olly-j/My-Train-Times#618. Status: draft source, not public-ready.

This copy prepares the station → train destination → departure-time story for the owner-selected corrected release. It removes obsolete launch/coming-soon notices and describes station resume, the large widget’s two directions and station tap, the Lock Screen board and Follow stops in ordinary product language. Existing Premium access, all prices, links, source qualification and privacy rules are unchanged.

## Current release candidate

The homepage shows eight Central line countdowns at Leyton, split by platform. Home shows a one-tap return to Brixton and saved Leyton. Follow shows train 021 at Liverpool Street towards Epping. All three are native captures from the iPhone 15 Pro simulator on build 1.2.6 (20261127000202), using controlled station and train data. The PNGs are original frames. Each WebP matches its decoded RGB pixels. The [asset manifest](website-refresh-20261117-assets.json) records the source and receipt for each image.

Add Station still uses build 20261117225101. By destination and Next departures retain their earlier capture identities. The social card comes from build 20261118001152. The separate Lock Screen and device storefront captures are kept with the app release evidence. The earlier paid Follow check used a local StoreKit transaction. Background delivery and physical Watch behaviour have their own release checks.

This branch is a website source draft. Publication is a separate owner decision. Its service base includes code beyond the currently deployed production version. A website-only release must select the intended deployable revision and preserve production service configuration.

## 26 November website review

The homepage leads with station search and train countdowns and explains Scheduled times separately. Follow a Train describes supported route and stop information, with live progress and sharing qualified by the train evidence. The Lock Screen Live Activity has three free sessions. The separate Home Screen and Lock Screen widgets require Premium. The support page gives the matching setup, recovery and refresh instructions.

The website branch incorporates service main at `ffe5c1fe5594a2270cfe129cf0952e78adbf0c40`. Hosted Service Quality exposed two earlier timing-dependent fixtures after the old draft fixes were dropped from the merge. The HTTP endpoint test now controls its test clock at a minute boundary, and the timer test waits for persistence or transport progress without advancing the virtual clock. Both retain their service assertions. Runtime and configuration match service main. The release candidate reviewed for claims is iOS 1.2.6 build 20261122004457 from app PR 916. Asset provenance remains per image.
