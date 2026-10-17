# gateway-sync (specs/006-litellm-gateway-billing): Node + psql, no npm packages.
FROM node:24-alpine
RUN apk add --no-cache postgresql17-client
WORKDIR /app
COPY lib.mjs sync.mjs health.mjs ./
USER node
CMD ["node", "/app/sync.mjs"]
