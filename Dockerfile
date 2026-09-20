FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# install opencode
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:${PATH}"

# install node dependencies
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# copy app
COPY server.js /app/server.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD curl -sf http://127.0.0.1:${PORT:-80}/health || exit 1
CMD ["/app/entrypoint.sh"]
