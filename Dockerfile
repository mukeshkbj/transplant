FROM node:24.21.0-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY server ./server
COPY web ./web
RUN npm run build:web

FROM node:24.21.0-slim
ENV NODE_ENV=production \
    PORT=8787 \
    STATIC_ROOT=/app/dist/web \
    CACHE_PATH=/data/qloo.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist/web ./dist/web
EXPOSE 8787
CMD ["node", "--import", "tsx", "server/src/main.ts"]
