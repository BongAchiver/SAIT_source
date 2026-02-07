FROM node:22-bookworm-slim

WORKDIR /app

# better-sqlite3 needs native build tooling on some platforms
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/chat.db

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
