FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV PORT=3000
ENV DB_PATH=/app/data/cards.db

EXPOSE 3000

CMD ["npm", "start"]