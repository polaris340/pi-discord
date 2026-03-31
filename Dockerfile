FROM node:22-slim

# Install Xvfb + x11vnc + noVNC + basic window manager
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify fluxbox \
    # common tools pi might need for browser/GUI
    chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm install -g @mariozechner/pi-coding-agent

COPY package.json package-lock.json ./
RUN npm ci

COPY bot.js start.sh ./
RUN chmod +x start.sh

WORKDIR /workspace

CMD ["/app/start.sh"]
