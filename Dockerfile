FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
# Prisma loads prisma.config.ts during client generation and therefore requires
# DATABASE_URL to be defined even though `generate` never connects to a database.
# Runtime and migration containers receive the real URL from Docker Compose.
RUN DATABASE_URL="postgresql://newsbot:build-only@127.0.0.1:5432/newsbot?schema=public" npm run prisma:generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini openssl
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

FROM dependencies AS migrator
WORKDIR /app
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
USER node
CMD ["npm", "run", "prisma:deploy"]
