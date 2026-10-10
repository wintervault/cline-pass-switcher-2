# ---- 构建阶段：装依赖 + 编译前后端 ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci
COPY server/ ./server/
COPY web/ ./web/
RUN npm run build --workspace=server && npm run build --workspace=web

# ---- 运行阶段：只带编译产物与 server 的生产依赖（pino/zod）----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV BIND_HOST=0.0.0.0
COPY package.json package-lock.json ./
COPY server/package.json ./server/
RUN npm ci --omit=dev
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

VOLUME /data
EXPOSE 3123
# /healthz 免鉴权，专供容器编排探活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3123/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server/dist/index.js"]
