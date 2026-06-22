# Roast — 单进程生产镜像:Node 服务同时托管 API(SSE)+ vite build 静态前端。
FROM node:24-slim
WORKDIR /app

# mcporter:中文/全网证据源(Exa 托管 MCP,免 key)经它调用。装到全局 bin(在 PATH)。
# 装不上/调不通时 evidence 层 allSettled 兜底,不崩——但要中文源生效,镜像里必须有它。
RUN npm i -g mcporter@0.11.1

# 先装依赖(利用层缓存)
COPY package.json package-lock.json* ./
RUN npm ci

# 拷源码并构建前端到 dist/
COPY . .
RUN npm run build

ENV ROAST_API_PORT=8787
# sqlite + 生成图片落到挂载卷,容器重建不丢
ENV ROAST_DATA_DIR=/data
EXPOSE 8787

# 密钥(OPENAI_API_KEY / KIMI_API_KEY / …)与 ROAST_ACCESS_PASSWORD 在运行时
# 用 -e 或平台环境变量注入,绝不进镜像/不进 git。
CMD ["node", "server/index.mjs"]
