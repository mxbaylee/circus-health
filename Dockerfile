FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci

FROM dependencies AS brand-tools
COPY src/scripts/ ./src/scripts/
COPY .prettierrc.json .prettierignore /app/
RUN mkdir -p /app/src/assets /app/src/app/components /app/src/public
ENTRYPOINT ["node", "src/scripts/generate-brand-assets.ts"]

FROM dependencies AS build
ARG CRS_BUILD_REVISION=unknown
ARG CRS_BUILD_WORKTREE=unknown
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY deploy/*.ts ./deploy/
COPY tsconfig*.json vite.config.ts vitest.config.ts commitlint.config.ts ./
COPY .prettierrc.json .prettierignore /app/
RUN CRS_BUILD_REVISION="$CRS_BUILD_REVISION" CRS_BUILD_WORKTREE="$CRS_BUILD_WORKTREE" npm run build -- --logLevel warn && npm prune --omit=dev --no-fund --no-audit

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ENV NODE_ENV=production CRS_DATA_DIR=/archive/data CRS_RUNTIME_DIR=/run/health CRS_PORT=3001 PLAYWRIGHT_BROWSERS_PATH=/opt/playwright CRS_AI_BACKEND=litellm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends qpdf tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
COPY LICENSE THIRD-PARTY-NOTICES.md /app/
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /archive/data /run/health && chown -R node:node /run/health /opt/playwright
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/src/shared ./src/shared
COPY --from=build /app/src/app/data/clinical.ts /app/src/app/data/format.ts ./src/app/data/
# The manifest and browser bundle are copied from the same completed build.
COPY --from=build /app/src/dist ./src/dist
RUN node --input-type=module -e "import { readBuildId } from './src/server/build-identity.ts'; if (!readBuildId('/app')) throw Error('Missing build identity');"
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD node -e 'fetch("http://127.0.0.1:3001/health/ready").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
CMD ["node", "src/server/runtime.ts"]
