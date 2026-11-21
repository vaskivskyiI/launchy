FROM docker.io/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 LAUNCHY_CONFIG=/config/config.yaml
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY config.example.yaml ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "src/server.js"]
