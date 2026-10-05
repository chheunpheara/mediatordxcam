# syntax=docker/dockerfile:1
#
# The browser-facing image of the default stack: builds the SPA and serves it
# with nginx, proxying /api, /health and /docs to the backend container so the
# product is single-origin from the browser's point of view (§30).
#
# Build context is the FRONTEND directory:
#
#     docker build -t camdx-kyc-frontend .
#
# docker-compose.yml already does this and publishes it on :3000.

FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json vite.config.ts eslint.config.js index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# `127.0.0.1`, not `localhost`: nginx listens on IPv4 only, and BusyBox wget in
# the alpine image resolves `localhost` to ::1 first, so the probe fails against a
# perfectly healthy server.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/healthz > /dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]