FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY index.html ./public/index.html

EXPOSE 8087

CMD ["node", "server.js"]
