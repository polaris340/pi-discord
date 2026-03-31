#!/bin/bash
set -e

# Start virtual framebuffer
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# Start window manager
fluxbox &

# Start VNC server (no password)
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &

# Start noVNC web client
websockify --web /usr/share/novnc 6080 localhost:5900 &

# Start the bot
exec node /app/bot.js
