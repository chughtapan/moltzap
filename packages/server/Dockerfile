FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/protocol/ packages/protocol/
COPY packages/server/ packages/server/
RUN pnpm --filter @moltzap/protocol build && pnpm --filter @moltzap/server-core build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/server/dist ./dist
COPY --from=builder /app/packages/server/bin ./bin
COPY --from=builder /app/packages/server/node_modules ./node_modules
COPY --from=builder /app/packages/server/package.json ./
COPY --from=builder /app/packages/protocol/dist ./node_modules/@moltzap/protocol/dist
COPY --from=builder /app/packages/protocol/package.json ./node_modules/@moltzap/protocol/
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/standalone.js"]
