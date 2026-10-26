# Crossbill on StartOS: the server (server/) and the screens it serves (dist-server), in one small image.
# Build from the repository's top folder:
#
#   docker build -f server/Dockerfile -t crossbill-server .
#
# The server needs nothing but Node.js itself at run time: no packages are installed in the final image.
# Node 22.18 or later runs its TypeScript as is. When the StartOS package builds this image, pin the base images
# by digest, as the workflows pin actions to commits.

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY plugins/shrike-native ./plugins/shrike-native
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:server

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    CROSSBILL_HOST=0.0.0.0 \
    CROSSBILL_PORT=8080 \
    CROSSBILL_DATA_DIR=/data \
    CROSSBILL_STATIC_DIR=/app/dist-server
WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/server ./server
COPY --from=build /src/dist-server ./dist-server
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "server/main.ts"]
