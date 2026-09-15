# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache tini
ENV NODE_ENV=production

FROM base AS deps
COPY package*.json ./
RUN npm ci --include=dev

FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 5000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "dev"]

FROM base AS production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY worker.js ./worker.js
RUN mkdir -p /app/storage && chown -R node:node /app
USER node
EXPOSE 5000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
