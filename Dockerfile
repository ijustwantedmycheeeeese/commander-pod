FROM node:20-alpine

# Real curl, not Node's own fetch -- Moxfield's deck-import API sits behind Cloudflare bot-detection
# that fingerprints Node's HTTP client specifically and blocks it (confirmed: an identical request
# succeeds from curl, gets a Cloudflare challenge page from Node fetch), so server.js shells out to
# this binary for that one call. See the curlJson() comment in server.js for the full story.
RUN apk add --no-cache curl

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
