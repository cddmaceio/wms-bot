FROM node:24-bookworm-slim AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3001 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
# A versão do CLI e a revisão Chromium vêm do lockfile, sem imagem divergente.
RUN ./node_modules/.bin/playwright install --with-deps chromium && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY automation ./automation
COPY bridge ./bridge
COPY public ./public
COPY login.js download.js ./
RUN node bridge/patch-wwebjs.cjs && mkdir -p /data
EXPOSE 3001
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
