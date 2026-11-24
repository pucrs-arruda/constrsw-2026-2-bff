# Imagem do serviço `bff` do compose do repositório base (build: ./backend/bff).
# Node pinado pela ARCHITECTURE-SPINE: 24.x (>=24.15).
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && apk add --no-cache curl
COPY --from=build /app/dist ./dist
COPY openapi ./openapi
USER node
# PORT e as demais variáveis vêm do compose do base; o default casa com BFF_INTERNAL_API_PORT.
EXPOSE 3001
CMD ["node", "dist/main"]
