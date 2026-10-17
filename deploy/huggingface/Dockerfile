# Hugging Face Space (Docker) for the public demo of my-search.
# The Space repository only needs this Dockerfile and README.md; the app itself is
# cloned from GitHub at build time, so the Space follows the main branch.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG REPO=https://github.com/jinghaodao-tech/my-search_public.git
ARG REF=main

# The node image already has user "node" (uid 1000), which Spaces run as.
RUN mkdir -p /home/node/app && chown node:node /home/node/app
USER node
WORKDIR /home/node/app

# Changes whenever the branch moves, so a rebuild picks up new commits instead of a cached clone.
ADD --chown=node:node https://api.github.com/repos/jinghaodao-tech/my-search_public/commits/${REF} /tmp/latest-commit.json
RUN git clone --depth 1 --branch "${REF}" "${REPO}" . && npm ci --omit=dev

ENV HOST=0.0.0.0 \
    PORT=7860 \
    DEMO_MODE=true \
    DB_PATH=/tmp/my-search-demo.db \
    READER_RATE_LIMIT=10 \
    READER_PDF_MAX_MB=10 \
    API_RATE_LIMIT=120

EXPOSE 7860
CMD ["npm", "start"]
