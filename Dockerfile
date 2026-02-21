FROM node:22-slim

WORKDIR /app

RUN npm install -g @mariozechner/pi-coding-agent

COPY package.json package-lock.json ./
RUN npm ci

COPY bot.js ./

WORKDIR /workspace

CMD ["node", "/app/bot.js"]
