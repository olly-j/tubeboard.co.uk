FROM node:22.21.1-slim

ARG TUBEBOARD_GIT_SHA=unknown

ENV NODE_ENV=production
ENV PORT=8080
ENV SITE_DIR=.
ENV LIVE_ACTIVITY_DATA_FILE=/data/live-activities.json
ENV TUBEBOARD_GIT_SHA=${TUBEBOARD_GIT_SHA}

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
# Exact reviewed producer closure; do not copy local pycache or unrelated tools.
COPY runtime/timetable-producer/manifest.json ./runtime/timetable-producer/
COPY runtime/timetable-producer/scripts/tb085_prepare_renewal.py \
     runtime/timetable-producer/scripts/tb085_package_timetable_proof.py \
     runtime/timetable-producer/scripts/tb085_timetable_publication.py \
     runtime/timetable-producer/scripts/tb085_monitor_publication.py \
     runtime/timetable-producer/scripts/tb085_source_transfer.py \
     runtime/timetable-producer/scripts/tb085_additive_qualification.py \
     runtime/timetable-producer/scripts/tb085_reference_readback.py \
     runtime/timetable-producer/scripts/tb085_live_parity.py \
     runtime/timetable-producer/scripts/tb085_tram_stations.py \
     runtime/timetable-producer/scripts/check_tfl_api_health.py \
     runtime/timetable-producer/scripts/tb085_renewal_roster.json ./runtime/timetable-producer/scripts/
COPY ["runtime/timetable-producer/TubeBoard Watch App/TubeStationCatalog.json", "./runtime/timetable-producer/TubeBoard Watch App/"]
COPY ["runtime/timetable-producer/My Train Times/PublishedLineMaps.json", "./runtime/timetable-producer/My Train Times/"]
COPY contracts ./contracts
COPY public/timetable-publications ./public/timetable-publications
COPY certificates ./certificates
COPY assets/fonts ./assets/fonts
COPY assets/product ./assets/product
COPY assets/tubeboard-icon-v3-32.png assets/tubeboard-icon-v3-180.png assets/tubeboard-icon-v3-512.png assets/tubeboard-og-20260724.png assets/tubeboard-og-v1-1-20260825.png ./assets/
COPY .well-known ./.well-known
COPY index.html privacy.html support.html train-v1.html 404.html styles-20260820.css site-20260724.js train-20260830-v2.css train-20260830-v2.js robots.txt sitemap.xml .nojekyll ./

EXPOSE 8080

CMD ["node", "server/index.js"]
