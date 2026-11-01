# Mashkif application image: the server plus the built web app.
#
# Build context: the repository root. Docker reads the deny-by-default ignore
# file next to this Dockerfile (app.Dockerfile.dockerignore), so only the
# sources and lockfiles listed there reach the build.
#
#   docker build -f config/docker/app.Dockerfile -t mashkif-app:dev .
#
# The GeoLite2-ASN database is never part of the image. The operator mounts it
# read-only at runtime and points MASHKIF_GEOIP_ASN_PATH at the file.

ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# Workspace manifests and the lockfile, shared by the build and runtime
# dependency stages so dependency layers stay cached until they change.
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY contracts/package.json contracts/
COPY server/package.json server/
COPY web/package.json web/

# Full install and production build of the server and the web app.
FROM manifests AS build
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN --mount=type=cache,id=mashkif-pnpm-store,target=/pnpm-store \
    corepack pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY contracts/generated/ contracts/generated/
COPY server/tsconfig.json server/tsconfig.build.json server/
COPY server/src/ server/src/
COPY server/drizzle/ server/drizzle/
COPY web/index.html web/tsconfig.json web/vite.config.ts web/
COPY web/public/ web/public/
COPY web/src/ web/src/
# Build contexts on Windows drives arrive world-writable; the runtime user
# must not be able to change the application files.
RUN corepack pnpm -r build \
    && test -f server/dist/main.js \
    && test -f server/drizzle/meta/_journal.json \
    && test -f web/dist/index.html \
    && chmod -R go-w server/package.json server/dist server/drizzle web/dist

# Production dependencies of the server only.
FROM manifests AS runtime-deps
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN --mount=type=cache,id=mashkif-pnpm-store,target=/pnpm-store \
    corepack pnpm install --frozen-lockfile --prod --filter @mashkif/server --store-dir /pnpm-store \
    && chmod -R go-w node_modules server/node_modules

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="Mashkif" \
      org.opencontainers.image.description="Mashkif server and web app" \
      org.opencontainers.image.source="https://github.com/ShlomiPorush/mashkif" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production PORT=8080

# Dedicated unprivileged runtime user. The application files stay owned by
# root, so the process cannot modify its own code.
RUN groupadd --system --gid 10001 mashkif \
    && useradd --system --uid 10001 --gid 10001 --no-create-home \
       --home-dir /nonexistent --shell /usr/sbin/nologin mashkif

WORKDIR /app
COPY --from=runtime-deps /src/node_modules/ node_modules/
COPY --from=runtime-deps /src/server/node_modules/ server/node_modules/
# server/dist/main.js resolves ../../web/dist and ../drizzle relative to its
# own location, and server/package.json marks the output as ES modules.
COPY --from=build /src/server/package.json server/
COPY --from=build /src/server/dist/ server/dist/
COPY --from=build /src/server/drizzle/ server/drizzle/
COPY --from=build /src/web/dist/ web/dist/

USER 10001:10001
EXPOSE 8080

# Readiness covers PostgreSQL connectivity and the GeoLite2-ASN file. The slim
# image has no curl or wget, so Node performs the request.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]

CMD ["node", "server/dist/main.js"]
