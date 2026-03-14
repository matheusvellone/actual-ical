ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

COPY package*.json .
RUN npm ci

COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV ACTUAL_SYNC_YEARS=1

COPY package*.json .
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-3000}/healthcheck || exit 1

EXPOSE ${PORT:-3000}

CMD ["node", "dist/bin/server.js"]
