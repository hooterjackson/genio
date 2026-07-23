FROM node:22.19.0-alpine

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run release:check \
  && pnpm run build:server

ENV NODE_ENV=production
CMD ["pnpm", "run", "start:api"]
