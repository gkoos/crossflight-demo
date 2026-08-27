FROM node:24-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY upstream/index.js ./index.js
CMD ["node", "index.js"]
