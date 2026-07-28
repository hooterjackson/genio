FROM node:22.19.0-alpine@sha256:d2166de198f26e17e5a442f537754dd616ab069c47cc57b889310a717e0abbf9

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .
ARG GENIO_BUILD_VERSION=""
ARG GENIO_BUILD_REVISION=""
ARG GENIO_RELEASE_VERIFICATION_KEY_SHA256=""
ARG GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256=""
RUN GENIO_BUILD_VERSION="$GENIO_BUILD_VERSION" \
  GENIO_BUILD_REVISION="$GENIO_BUILD_REVISION" \
  GENIO_RELEASE_VERIFICATION_KEY_SHA256="$GENIO_RELEASE_VERIFICATION_KEY_SHA256" \
  GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256="$GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256" \
  node -e 'const fs=require("node:fs"); const pkg=require("./package.json"); const suppliedVersion=process.env.GENIO_BUILD_VERSION||pkg.version; const suppliedRevision=(process.env.GENIO_BUILD_REVISION||"").toLowerCase(); const releaseVerificationKeySha256=(process.env.GENIO_RELEASE_VERIFICATION_KEY_SHA256||"").toLowerCase(); const publicRolloutIntentCanaryAuthorityPolicySha256=(process.env.GENIO_PUBLIC_ROLLOUT_INTENT_CANARY_AUTHORITY_POLICY_SHA256||"").toLowerCase(); if(!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(suppliedVersion)) throw new Error("invalid embedded build version"); if(suppliedRevision&&!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(suppliedRevision)) throw new Error("invalid embedded build revision"); if(releaseVerificationKeySha256&&!/^[0-9a-f]{64}$/.test(releaseVerificationKeySha256)) throw new Error("invalid embedded release verification key hash"); if(publicRolloutIntentCanaryAuthorityPolicySha256&&!/^[0-9a-f]{64}$/.test(publicRolloutIntentCanaryAuthorityPolicySha256)) throw new Error("invalid embedded public rollout intent-canary authority policy hash"); fs.writeFileSync(".genio-build.json",JSON.stringify({schemaVersion:"genio-embedded-build/v1",version:suppliedVersion,revision:suppliedRevision||null,releaseVerificationKeySha256:releaseVerificationKeySha256||null,publicRolloutIntentCanaryAuthorityPolicySha256:publicRolloutIntentCanaryAuthorityPolicySha256||null})+"\n",{mode:0o444});'
RUN pnpm run release:check \
  && pnpm run build:server

LABEL org.opencontainers.image.version="$GENIO_BUILD_VERSION"
LABEL org.opencontainers.image.revision="$GENIO_BUILD_REVISION"
ENV NODE_ENV=production
CMD ["pnpm", "run", "start:api"]
