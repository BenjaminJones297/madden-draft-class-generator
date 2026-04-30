# node-sidecar/Dockerfile
FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy source files
COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
