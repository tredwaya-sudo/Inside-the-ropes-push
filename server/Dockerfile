FROM node:20-bookworm-slim

# better-sqlite3 needs native build tooling
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests

RUN npm run build \
  && npm prune --omit=dev

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATABASE_PATH=./data/push.sqlite

EXPOSE 8787

CMD ["npm", "start"]
