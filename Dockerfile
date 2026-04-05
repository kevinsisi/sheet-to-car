FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ git
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++ git
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && rm -rf /root/.npm
COPY --from=builder /app/dist dist/
COPY src/db/migrations dist/db/migrations/
COPY src/prompts dist/prompts/
COPY src/public dist/public/
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
