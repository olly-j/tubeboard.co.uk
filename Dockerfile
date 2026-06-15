FROM node:22.21.1-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV SITE_DIR=.
ENV LIVE_ACTIVITY_DATA_FILE=/data/live-activities.json

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY assets ./assets
COPY index.html privacy.html support.html styles.css CNAME .nojekyll ./

EXPOSE 8080

CMD ["node", "server/index.js"]
