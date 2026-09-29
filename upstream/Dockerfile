FROM node:24-alpine
WORKDIR /app

# Install dependencies from root package manifest
COPY package.json .
RUN npm install --omit=dev

COPY upstream/src ./src
CMD ["node", "--experimental-strip-types", "src/index.ts"]
