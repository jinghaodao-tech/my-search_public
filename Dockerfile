FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY --chown=node:node . .
RUN mkdir -p /app/data && chown -R node:node /app

ENV PORT=3000
ENV DB_PATH=/app/data/cards.db

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

EXPOSE 3000

CMD ["npm", "start"]
