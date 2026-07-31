FROM node:22.21.1-slim

ARG TUBEBOARD_GIT_SHA=unknown

ENV NODE_ENV=production
ENV PORT=8080
ENV SITE_DIR=.
ENV LIVE_ACTIVITY_DATA_FILE=/data/live-activities.json
ENV TUBEBOARD_GIT_SHA=${TUBEBOARD_GIT_SHA}

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY assets/product ./assets/product
COPY assets/tubeboard-icon-v3-32.png assets/tubeboard-icon-v3-180.png assets/tubeboard-icon-v3-512.png assets/tubeboard-og-20260724.png ./assets/
COPY index.html privacy.html support.html 404.html styles-20260724c.css site-20260724.js robots.txt sitemap.xml .nojekyll ./

EXPOSE 8080

CMD ["node", "server/index.js"]
