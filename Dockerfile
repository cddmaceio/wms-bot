ARG WMS_PASS
ARG WMS_USER
ARG PORT
ARG SESSION_FILE
ARG DOWNLOAD_DIR
ARG APP_API_URL
ARG APP_API_TOKEN
ARG APP_API_ENDPOINT


FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

# Instala browsers do Playwright
RUN npx playwright install chromium

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
