ARG NODE_IMAGE=node:24.22.2-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_DIR=/data
USER node
CMD ["node", "dist/server/server/main.js"]

FROM ${NODE_IMAGE} AS browser-platform
WORKDIR /app
COPY package*.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright

FROM browser-platform AS browser
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
USER node
ENV NODE_ENV=production
CMD ["node", "dist/server/browser/main.js"]
