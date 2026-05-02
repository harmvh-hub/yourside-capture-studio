FROM node:22-alpine

# FFmpeg with SRT support
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json server.js ./
COPY public/ ./public/

RUN mkdir -p /data/recordings /data/exports /data/db

ENV RECORDINGS_DIR=/data/recordings
ENV EXPORTS_DIR=/data/exports
ENV DATA_DIR=/data/db
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/version || exit 1

CMD ["node", "--experimental-sqlite", "server.js"]
