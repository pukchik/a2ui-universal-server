FROM node:24-bookworm-slim
RUN npm install --global pnpm@12.14.0 @openai/codex@0.163.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
USER node
ENV HOST=0.0.0.0 PORT=3100 NODE_ENV=production
EXPOSE 3100
CMD ["node", "demo/server/main.ts"]
