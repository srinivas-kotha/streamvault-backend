FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg curl
RUN addgroup -S streamvault && adduser -S streamvault -G streamvault
RUN mkdir -p /data/streamvault/downloads /data/streamvault/recordings /tmp/streamvault-hls \
    && chown -R streamvault:streamvault /app /data/streamvault /tmp/streamvault-hls
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
USER streamvault
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:3001/health || exit 1
CMD ["node", "dist/index.js"]
