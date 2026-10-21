FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY scripts/ ./scripts/
COPY public/ ./public/
ENV PORT=3000 HOST=0.0.0.0 DATA_DIR=/app/data NODE_ENV=production
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
