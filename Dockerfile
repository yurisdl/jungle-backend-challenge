FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["bun", "src/main.ts"]
