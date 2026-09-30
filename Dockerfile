FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=8080

USER node

CMD ["node", "src/server.mjs"]
