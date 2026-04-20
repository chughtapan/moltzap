FROM node:22-alpine AS builder
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
RUN pnpm --filter @moltzap/protocol build && pnpm --filter @moltzap/server-core build
RUN pnpm --filter @moltzap/server-core deploy --legacy --prod /app/deploy

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/deploy ./
COPY --from=builder /app/packages/server/bin ./bin
COPY --from=builder /app/packages/server/src/app/core-schema.sql ./core-schema.sql
EXPOSE 41973
ENV NODE_ENV=production
CMD ["node", "dist/standalone.js"]
