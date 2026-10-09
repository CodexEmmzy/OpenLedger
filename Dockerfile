FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
COPY worker/package.json worker/
COPY simulator/package.json simulator/

RUN npm ci --include=dev

COPY . .

ARG SERVICE=api
ENV SERVICE=${SERVICE}

EXPOSE 3000 3001

CMD ["sh", "-c", "npm run start -w @openledger/${SERVICE}"]
