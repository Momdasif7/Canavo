# Build from the repo root:  docker build -f apps/api/Dockerfile -t canavo-api .
FROM node:22-slim AS build
WORKDIR /repo
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN npm ci --workspace @canavo/api --workspace @canavo/shared --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @canavo/shared && npm run build -w @canavo/api

FROM node:22-slim
WORKDIR /repo
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 4000
# Apply pending migrations, then start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
