FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /source
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build
RUN pnpm --filter @team-synergy/core-api deploy --legacy --prod /prod/api \
    && find /prod/api -type d \( -name tests -o -name docs -o -name .git \) -prune -exec rm -rf '{}' +

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production TSP_AUTO_MIGRATE=false
WORKDIR /app
COPY --from=build --chown=node:node /prod/api/ ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]

FROM nginxinc/nginx-unprivileged:stable-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /source/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
