# Build both TypeScript applications once, then copy only their runtime assets
# into the two small deploy targets selected by docker-compose.yml.
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm install --ignore-scripts && npm run build && npm --prefix web run build

FROM node:22-bookworm-slim AS api
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "dist/server/src/main.js"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist/web /usr/share/nginx/html
# The compiled browser modules import '../../shared/src/*.js', which the
# browser resolves to the root-clamped URL /shared/..., so the shared tree
# must live inside the served docroot.
COPY --from=build /app/web/dist/shared /usr/share/nginx/html/shared
EXPOSE 8080
