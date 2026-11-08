# Build from the repo root:  docker build -f apps/api/Dockerfile -t canavo-api .
FROM node:22-slim AS build
WORKDIR /repo
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
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
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Secrets come from the platform's environment at runtime; .dockerignore keeps .env files out of the image.
COPY --from=build --chown=node:node /repo /repo
COPY --chmod=755 apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# The entrypoint makes the storage disk writable, then runs the command as the unprivileged `node` user
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint -- the entrypoint drops to `node` via setpriv
ENTRYPOINT ["docker-entrypoint.sh"]
# Apply pending migrations, then start
# nosemgrep: dockerfile.security.missing-user.missing-user -- runs through the entrypoint, which drops to `node`
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
