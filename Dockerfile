FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p data/reports data/snapshots

ENV NODE_ENV=production

CMD ["npm", "start"]
