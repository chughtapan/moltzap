FROM node:22-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server-core/package.json packages/server-core/
RUN corepack enable && pnpm install --frozen-lockfile
COPY packages/protocol/ packages/protocol/
COPY packages/server-core/ packages/server-core/
RUN pnpm --filter @moltzap/protocol build && pnpm --filter @moltzap/server-core build

FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/packages/server-core/dist ./dist
COPY --from=builder /app/packages/server-core/node_modules ./node_modules
COPY --from=builder /app/packages/server-core/package.json ./
COPY --from=builder /app/packages/protocol/dist ./node_modules/@moltzap/protocol/dist
COPY --from=builder /app/packages/protocol/package.json ./node_modules/@moltzap/protocol/
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
