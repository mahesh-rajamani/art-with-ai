FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy app
COPY server/ ./server/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "server/index.js"]
