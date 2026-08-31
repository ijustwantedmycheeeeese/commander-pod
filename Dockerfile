FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY index.html ./public/index.html
COPY audio ./public/audio
COPY admin-server.js ./
COPY admin-public ./admin-public

EXPOSE 8087
EXPOSE 9091

CMD ["node", "server.js"]
