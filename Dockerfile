FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js admin.js ./
COPY admin ./admin
COPY tools ./tools
# Sessions and display preferences are stored here; mount a volume so they survive container rebuilds.
ENV TOKEN_FILE=/app/data/tokens.json
VOLUME /app/data
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8096
CMD ["node", "server.js"]
